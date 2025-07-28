import type { ActionFunctionArgs} from "@remix-run/node";
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
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // CORS headers for actual request
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  try {
    // Parse request body
    const body = await request.json();
    const { productId, cartId, customerId, shop } = body;

    if (!productId || !cartId || !shop) {
      return json(
        { 
          success: false, 
          error: "Missing required fields: productId, cartId, or shop" 
        },
        { 
          status: 400,
          headers: corsHeaders 
        }
      );
    }

    // Authenticate with Shopify
    const { admin } = await authenticate.public.appProxy(request);

    // Update product metafields
    const metafieldsToUpdate = [
      {
        namespace: "reservation",
        key: "is_reserved",
        value: "true",
        type: "boolean"
      },
      {
        namespace: "reservation", 
        key: "cart_id",
        value: cartId,
        type: "single_line_text_field"
      }
    ];

    // Update metafields via GraphQL
    const metafieldMutations = metafieldsToUpdate.map(metafield => 
      admin.graphql(`
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
      `, {
        variables: {
          metafields: [{
            ownerId: `gid://shopify/Product/${productId}`,
            namespace: metafield.namespace,
            key: metafield.key,
            value: metafield.value,
            type: metafield.type
          }]
        }
      })
    );

    // Execute all metafield updates
    const metafieldResults = await Promise.all(metafieldMutations);
    
    // Check for errors
    const hasErrors = metafieldResults.some(result => 
      result.body?.data?.metafieldsSet?.userErrors?.length > 0
    );

    if (hasErrors) {
      const errors = metafieldResults.flatMap(result => 
        result.body?.data?.metafieldsSet?.userErrors || []
      );
      return json(
        { 
          success: false, 
          error: "Failed to update metafields", 
          details: errors 
        },
        { 
          status: 500,
          headers: corsHeaders 
        }
      );
    }

    // Store reservation in database
    const reservation = await prisma.productReservation.upsert({
      where: {
        productId_cartId: {
          productId: productId.toString(),
          cartId: cartId.toString()
        }
      },
      update: {
        isReserved: true,
        customerId: customerId?.toString() || null,
        updatedAt: new Date()
      },
      create: {
        productId: productId.toString(),
        cartId: cartId.toString(),
        customerId: customerId?.toString() || null,
        isReserved: true
      }
    });

    return json({
      success: true,
      reservation: {
        id: reservation.id,
        productId: reservation.productId,
        cartId: reservation.cartId,
        customerId: reservation.customerId,
        isReserved: reservation.isReserved,
        createdAt: reservation.createdAt
      }
    }, {
      headers: corsHeaders
    });

  } catch (error) {
    console.error("Reservation error:", error);
    
    return json(
      { 
        success: false, 
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { 
        status: 500,
        headers: corsHeaders 
      }
    );
  }
};

// Handle GET requests with CORS
export const loader = () => {
  return json(
    { message: "Reservation API endpoint. Use POST to create reservations." },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      }
    }
  );
};