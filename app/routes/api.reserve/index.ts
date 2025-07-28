import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "app/shopify.server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const action = async ({ request }: ActionFunctionArgs) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const body = await request.json();
    const { productId, cartId, customerId, shop } = body;
    console.log("🚀 ~ action ~ productId:", productId)

    

    if (!productId || !cartId || !shop) {
      return json(
        {
          success: false,
          error: "Missing required fields: productId, cartId, or shop",
        },
        {
          status: 400,
          headers: corsHeaders,
        }
      );
    }

    // Authenticate with Shopify
    const { admin } = await authenticate.public.appProxy(request);

    // Step 1: Convert numeric variant ID to GID
    const variantGID = `gid://shopify/ProductVariant/${productId}`;

    // Step 2: Query for the parent product ID
    const variatQuery = `
      query getProductFromVariant($id: ID!) {
        productVariant(id: $id) {
          id
          product {
            id
          }
        }
      }
    `;

    const variables = {
      id: variantGID,
    };

    const variantResult = await admin?.graphql(variatQuery, { variables });

    const variantResponse = await variantResult?.json();
    const realProductGID = variantResponse?.data?.productVariant?.product?.id;
    console.log("🚀 ~ action ~ realProductGID:", realProductGID)

    if (!realProductGID) {
      throw new Error("Could not resolve product ID from variant ID");
    }

    // Define metafields
    const metafields = [
      {
        ownerId: `${realProductGID.toString()}`,
        namespace: "reservation",
        key: "is_reserved",
        value: "true",
        type: "boolean",
      },
      {
        ownerId: `${realProductGID.toString()}`,
        namespace: "reservation",
        key: "cart_id",
        value: cartId.toString(),
        type: "single_line_text_field",
      },
    ];

    // Send metafieldsSet mutation
    const result = await admin?.graphql(
      `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
      {
        variables: { metafields },
      }
    );

    const responseJson = await result?.json();
    const userErrors = responseJson?.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length > 0) {
      console.error("Metafield update errors:", userErrors);
      return json(
        {
          success: false,
          error: "Failed to update metafields",
          details: userErrors,
        },
        {
          status: 500,
          headers: corsHeaders,
        }
      );
    }

    // Store reservation in database
    const reservation = await prisma.productReservation.upsert({
      where: {
        productId_cartId: {
          productId: realProductGID.toString(),
          cartId: cartId.toString(),
        },
      },
      update: {
        isReserved: true,
        customerId: customerId?.toString() || null,
        updatedAt: new Date(),
      },
      create: {
        productId: realProductGID.toString(),
        cartId: cartId.toString(),
        customerId: customerId?.toString() || null,
        isReserved: true,
      },
    });

    return json(
      {
        success: true,
        reservation: {
          id: reservation.id,
          productId: reservation.productId,
          cartId: reservation.cartId,
          customerId: reservation.customerId,
          isReserved: reservation.isReserved,
          createdAt: reservation.createdAt,
        },
      },
      {
        headers: corsHeaders,
      }
    );
  } catch (error) {
    console.error("Reservation error:", error);
    return json(
      {
        success: false,
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      {
        status: 500,
        headers: corsHeaders,
      }
    );
  }
};

export const loader = () => {
  return json(
    { message: "Reservation API endpoint. Use POST to create reservations." },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    }
  );
};
