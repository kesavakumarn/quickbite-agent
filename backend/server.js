require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const UPI_ID = process.env.UPI_ID || "9966392629@ybl";

// WhatsApp Secrets
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// List of models to try in order of preference / generosity
const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
];

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

// Initialize Resend Email Client
const resend = new Resend(process.env.RESEND_API_KEY || "");

// In-memory sessions cart (session_id or whatsapp_phone -> items array)
const carts = new Map();

function getCart(sessionId) {
  if (!carts.has(sessionId)) carts.set(sessionId, []);
  return carts.get(sessionId);
}

function calculateTotal(cart) {
  return cart.reduce((sum, item) => sum + item.price * item.qty, 0);
}

// Helper: Send message back to WhatsApp
async function sendWhatsAppMessage(toPhone, textMessage) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.error("WhatsApp credentials missing in environment variables.");
    return;
  }
  const url = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toPhone,
        text: { body: textMessage },
      }),
    });
  } catch (err) {
    console.error("Error sending WhatsApp message:", err.message);
  }
}

// Helper: Call Gemini with model fallbacks and 429 retry backoff
async function callGeminiWithFallback(body) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY environment variable/secret.");
  }

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    let retryCount = 0;
    const maxRetries = 2;

    while (retryCount <= maxRetries) {
      try {
        console.log(`Trying model: ${model}` + (retryCount > 0 ? ` (retry ${retryCount})` : ""));

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (resp.status === 429) {
          if (retryCount < maxRetries) {
            const waitTime = Math.pow(2, retryCount) * 5000;
            console.log(`  -> Rate-limited (429). Waiting ${waitTime / 1000}s before retry...`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            retryCount++;
            continue;
          } else {
            console.log(`  -> ${model} exhausted retries. Trying next model...`);
            lastError = `${model}: 429 Too Many Requests`;
            break;
          }
        }

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${errText}`);
        }

        const data = await resp.json();
        console.log(`  -> Success with ${model}`);
        return data;
      } catch (err) {
        console.log(`  -> ${model} failed: ${err.message}`);
        lastError = err.message;
        break;
      }
    }
  }

  throw new Error(`All Gemini models failed. Last error: ${lastError}`);
}

// ---------------- REUSABLE CORE LOGIC ----------------

// Core Chat Processor
async function processChatLogic(sessionId, message) {
  const cart = getCart(sessionId);

  const { data: menuItems } = await supabase
    .from("menu")
    .select("*")
    .eq("is_available", true);

  const menuContext = (menuItems || [])
    .map((m) => `${m.name} (ID: ${m.id}) - ₹${m.price} - ${m.description}`)
    .join("\n");

  // UPDATED SYSTEM PROMPT: Forces AI to ask one by one
  const systemPrompt = `You are a polite, modern food ordering assistant for "QuickBite". Keep your tone friendly, brief, and slightly casual.
Available Dynamic Menu:
${menuContext}

Current Cart: ${cart.length ? JSON.stringify(cart) : "empty"}

Task Instructions:
1. Help the user add/remove menu items.
2. Collect four mandatory delivery details from the customer before completing checkout:
   - Full Name
   - Phone Number
   - Delivery Address
   - Email Address
   CRITICAL RULE: You MUST ask for these missing details STRICTLY ONE AT A TIME. Wait for the user to answer the current question before asking for the next missing detail. Never ask for multiple missing details in a single message.
3. Always reply strictly with a single valid JSON object in this exact schema (no markdown code blocks, no extra prose):
{
  "reply": "<Friendly assistant message to the customer>",
  "cart_actions": [
    {"action": "add"|"remove"|"clear", "item_name": "<exact menu item name>", "quantity": <integer>}
  ],
  "customer_details": {
    "name": "<extracted name or empty string>",
    "phone": "<extracted phone or empty string>",
    "email": "<extracted email or empty string>",
    "address": "<extracted address or empty string>"
  },
  "ready_to_checkout": <boolean>
}
Note: Set ready_to_checkout to true ONLY when cart has at least 1 item AND all 4 customer details (Name, Phone, Email, Address) have been collected.`;

  const body = {
    contents: [{ role: "user", parts: [{ text: message }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
  };

  const data = await callGeminiWithFallback(body);
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = {
      reply: rawText,
      cart_actions: [],
      customer_details: {},
      ready_to_checkout: false,
    };
  }

  for (const action of parsed.cart_actions || []) {
    if (action.action === "clear") {
      cart.length = 0;
      continue;
    }
    const itemMatch = (menuItems || []).find((m) =>
      m.name.toLowerCase().includes((action.item_name || "").toLowerCase())
    );
    if (!itemMatch) continue;

    const qty = Math.max(1, parseInt(action.quantity, 10) || 1);
    const existing = cart.find((c) => c.itemId === itemMatch.id);

    if (action.action === "add") {
      if (existing) existing.qty += qty;
      else
        cart.push({
          itemId: itemMatch.id,
          name: itemMatch.name,
          price: itemMatch.price,
          qty,
        });
    } else if (action.action === "remove" && existing) {
      existing.qty -= qty;
      if (existing.qty <= 0) {
        const idx = cart.indexOf(existing);
        cart.splice(idx, 1);
      }
    }
  }

  return {
    reply: parsed.reply || "How can I help with your order?",
    cart,
    total: calculateTotal(cart),
    customerDetails: parsed.customer_details || {},
    readyToCheckout: !!parsed.ready_to_checkout,
  };
}

// Core Checkout Processor
async function processCheckoutLogic(sessionId, customerDetails) {
  const cart = getCart(sessionId);

  if (!cart.length) {
    throw new Error("Cart is empty");
  }

  const total = calculateTotal(cart);

  const { data: order, error } = await supabase
    .from("orders")
    .insert([
      {
        session_id: sessionId,
        customer_name: customerDetails?.name || "Guest",
        customer_phone: customerDetails?.phone || "N/A",
        customer_email: customerDetails?.email || "N/A",
        delivery_address: customerDetails?.address || "N/A",
        items: cart,
        total_amount: total,
        status: "PENDING_PAYMENT",
      },
    ])
    .select()
    .single();

  if (error) throw error;

  const shortOrderId = order.id.slice(0, 8);
  const upiUrl = `upi://pay?pa=${UPI_ID}&pn=QuickBite&tr=${order.id}&am=${total}&cu=INR&tn=Order_${shortOrderId}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
    upiUrl
  )}`;

  return { orderId: order.id, total, upiUrl, qrCodeUrl, upiId: UPI_ID };
}

// ---------------- ENDPOINTS ----------------

// 1. Fetch Dynamic Menu
app.get("/api/menu", async (req, res) => {
  try {
    const { data: menu, error } = await supabase
      .from("menu")
      .select("*")
      .eq("is_available", true);
    if (error) throw error;
    res.json({ menu });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch menu", detail: err.message });
  }
});

// 2. Chat Endpoint 
app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
      return res
        .status(400)
        .json({ error: "sessionId and message are required" });
    }

    const result = await processChatLogic(sessionId, message);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: "Gemini API error", detail: err.message });
  }
});

// 3. Checkout Endpoint 
app.post("/api/checkout", async (req, res) => {
  try {
    const { sessionId, customerDetails } = req.body;
    const result = await processCheckoutLogic(sessionId, customerDetails);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Checkout error", detail: err.message });
  }
});

// 4. Confirm Payment 
app.post("/api/confirm-payment", async (req, res) => {
  try {
    const { orderId } = req.body;

    const { data: order, error } = await supabase
      .from("orders")
      .update({ status: "PAID_CONFIRMED" })
      .eq("id", orderId)
      .select()
      .single();

    if (error) throw error;

    if (order.customer_email && order.customer_email.includes("@")) {
      const itemsList = (order.items || [])
        .map(
          (i) =>
            `<li>${i.qty}x <strong>${i.name}</strong> - ₹${i.price * i.qty}</li>`
        )
        .join("");

      await resend.emails.send({
        from: process.env.SENDER_EMAIL || "onboarding@resend.dev",
        to: order.customer_email,
        subject: `Order Confirmed - QuickBite #${order.id.slice(0, 8)}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
            <h2 style="color: #ffb100;">Order Confirmed! 🎉</h2>
            <p>Hi <strong>${order.customer_name}</strong>,</p>
            <p>Thank you for ordering with QuickBite. Your payment has been received!</p>
            <hr />
            <h3>Delivery Details:</h3>
            <p><strong>Address:</strong> ${order.delivery_address}<br/>
               <strong>Phone:</strong> ${order.customer_phone}</p>
            <h3>Order Items:</h3>
            <ul>${itemsList}</ul>
            <p style="font-size: 16px;"><strong>Total Paid:</strong> ₹${order.total_amount}</p>
          </div>
        `,
      });
    }

    carts.delete(order.session_id);

    res.json({
      status: "SUCCESS",
      message: "Payment confirmed and notification email dispatched.",
      order,
    });
  } catch (err) {
    res.status(500).json({ error: "Confirmation failed", detail: err.message });
  }
});

// ---------------- WHATSAPP WEBHOOK ROUTING ----------------

// 5. Meta Webhook Verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WhatsApp Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 6. Receive Incoming WhatsApp Messages
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const msg = change.value?.messages?.[0];
        if (msg && msg.type === "text") {
          const customerPhone = msg.from; 
          const incomingText = msg.text.body;

          console.log(`Received WhatsApp msg from ${customerPhone}: ${incomingText}`);

          const chatResult = await processChatLogic(customerPhone, incomingText);

          if (chatResult.reply) {
            await sendWhatsAppMessage(customerPhone, chatResult.reply);
          }

          if (chatResult.readyToCheckout && chatResult.cart?.length > 0) {
            const checkoutResult = await processCheckoutLogic(
              customerPhone,
              chatResult.customerDetails
            );
            
            const upiMessage = `🎉 *Order Confirmed! (Total: ₹${checkoutResult.total})*\n\nTap below to pay via GPay / PhonePe / Paytm:\n${checkoutResult.upiUrl}`;
            await sendWhatsAppMessage(customerPhone, upiMessage);
          }
        }
      }
    }
  } catch (err) {
    console.error("WhatsApp Webhook processing error:", err.message);
  }
});

app.get("/health", (req, res) =>
  res.json({ status: "ok", timestamp: new Date() })
);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
