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

// Guaranteed Free-Tier Models as of July 2026
const GEMINI_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro"
];

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

// Initialize Resend Email Client
const resend = new Resend(process.env.RESEND_API_KEY || "");

// In-memory sessions (MEMORY BANKS)
const carts = new Map();
const customerSessions = new Map();

function getCart(sessionId) {
  if (!carts.has(sessionId)) carts.set(sessionId, []);
  return carts.get(sessionId);
}

function getCustomerDetails(sessionId) {
  if (!customerSessions.has(sessionId)) customerSessions.set(sessionId, {});
  return customerSessions.get(sessionId);
}

function calculateTotal(cart) {
  return cart.reduce((sum, item) => sum + item.price * item.qty, 0);
}

// Helper: Call Gemini with model fallbacks AND AGGRESSIVE LOGGING
async function callGeminiWithFallback(body) {
  if (!GEMINI_API_KEY) {
    console.error("[GEMINI ERROR] Missing GEMINI_API_KEY environment variable.");
    throw new Error("Missing GEMINI_API_KEY.");
  }
  
  let lastError = null;

  for (const model of GEMINI_MODELS) {
    let retryCount = 0;
    while (retryCount <= 2) {
      try {
        console.log(`[GEMINI] Attempting model: ${model} (Retry: ${retryCount})`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (resp.status === 429) {
          console.warn(`[GEMINI] Rate limited (429) on ${model}. Waiting to retry...`);
          if (retryCount < 2) {
            await new Promise((res) => setTimeout(res, Math.pow(2, retryCount) * 5000));
            retryCount++;
            continue;
          } else {
            lastError = `${model}: 429 Too Many Requests`;
            break;
          }
        }

        if (!resp.ok) {
          const errText = await resp.text();
          console.error(`[GEMINI ERROR] HTTP ${resp.status} from ${model}: ${errText}`);
          throw new Error(`HTTP ${resp.status}`);
        }
        
        console.log(`[GEMINI] Success with model: ${model}`);
        return await resp.json();
      } catch (err) {
        console.error(`[GEMINI ERROR] Model ${model} failed: ${err.message}`);
        lastError = err.message;
        break; // Move to the next model in the list
      }
    }
  }
  console.error("[GEMINI FATAL] All models failed.");
  throw new Error(`All Gemini models failed. Last error: ${lastError}`);
}

// Core Chat Processor
async function processChatLogic(sessionId, message) {
  console.log(`\n--- NEW CHAT REQUEST --- Session: ${sessionId}`);
  console.log(`User says: "${message}"`);

  const cart = getCart(sessionId);
  const knownDetails = getCustomerDetails(sessionId);

  console.log("[SUPABASE] Fetching menu...");
  const { data: menuItems, error: menuError } = await supabase
    .from("menu")
    .select("*")
    .eq("is_available", true);

  if (menuError) {
    console.error("[SUPABASE ERROR] Failed to fetch menu:", menuError);
    throw new Error("Database failed to load menu.");
  }
  console.log(`[SUPABASE] Successfully loaded ${menuItems?.length || 0} menu items.`);

  const menuContext = (menuItems || [])
    .map((m) => `${m.name} (ID: ${m.id}) - ₹${m.price} - ${m.description}`)
    .join("\n");

  const systemPrompt = `You are a polite, modern food ordering assistant for "QuickBite". Keep your tone friendly and brief.
Available Dynamic Menu:
${menuContext}

Current Cart: ${cart.length ? JSON.stringify(cart) : "empty"}
Details Already Collected: ${JSON.stringify(knownDetails)}

Task Instructions:
1. Help the user add/remove menu items.
2. Collect four mandatory delivery details: Name, Phone, Email, Address.
   CRITICAL RULE: Check the "Details Already Collected" JSON above. DO NOT ask for any detail that is already filled out. Only ask for the MISSING details, STRICTLY ONE AT A TIME. Wait for the user to answer before asking for the next one.
3. Always reply strictly with a single valid JSON object in this exact schema (no markdown, no backticks):
{
  "reply": "<Friendly assistant message to the customer>",
  "cart_actions": [
    {"action": "add"|"remove"|"clear", "item_name": "<exact menu item name>", "quantity": <integer>}
  ],
  "customer_details": {
    "name": "<extracted name or empty string if unknown>",
    "phone": "<extracted phone or empty string if unknown>",
    "email": "<extracted email or empty string if unknown>",
    "address": "<extracted address or empty string if unknown>"
  }
}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: message }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
  };

  const data = await callGeminiWithFallback(body);
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  
  // Safely strip markdown if Gemini ignores instructions
  const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleanText);
    console.log("[PARSER] Successfully parsed Gemini JSON response.");
  } catch (err) {
    console.error("[PARSER ERROR] Failed to parse Gemini response as JSON. Raw output:", rawText);
    parsed = { reply: cleanText, cart_actions: [], customer_details: {} };
  }

  // Handle Cart Updates
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
      else cart.push({ itemId: itemMatch.id, name: itemMatch.name, price: itemMatch.price, qty });
    } else if (action.action === "remove" && existing) {
      existing.qty -= qty;
      if (existing.qty <= 0) cart.splice(cart.indexOf(existing), 1);
    }
  }

  // Update known details without overwriting existing data
  if (parsed.customer_details) {
    Object.keys(parsed.customer_details).forEach(key => {
      if (parsed.customer_details[key] && parsed.customer_details[key].trim() !== "") {
        knownDetails[key] = parsed.customer_details[key].trim();
      }
    });
  }

  const isReady = 
    cart.length > 0 && 
    !!knownDetails.name && 
    !!knownDetails.phone && 
    !!knownDetails.email && 
    !!knownDetails.address;

  console.log(`[STATE] Cart Total: ₹${calculateTotal(cart)} | Ready for checkout: ${isReady}`);

  return {
    reply: parsed.reply || "How can I help with your order?",
    cart,
    total: calculateTotal(cart),
    customerDetails: knownDetails, 
    readyToCheckout: isReady,
  };
}

// Core Checkout Processor
async function processCheckoutLogic(sessionId, customerDetails) {
  console.log(`[CHECKOUT] Processing checkout for session: ${sessionId}`);
  const cart = getCart(sessionId);
  if (!cart.length) throw new Error("Cart is empty");

  const total = calculateTotal(cart);

  console.log("[SUPABASE] Saving order to database...");
  const { data: order, error } = await supabase
    .from("orders")
    .insert([{
        session_id: sessionId,
        customer_name: customerDetails?.name || "Guest",
        customer_phone: customerDetails?.phone || "N/A",
        customer_email: customerDetails?.email || "N/A",
        delivery_address: customerDetails?.address || "N/A",
        items: cart,
        total_amount: total,
        status: "PENDING_PAYMENT",
    }])
    .select().single();

  if (error) {
    console.error("[SUPABASE ERROR] Failed to save order:", error);
    throw error;
  }

  const shortOrderId = order.id.slice(0, 8);
  const upiUrl = `upi://pay?pa=${UPI_ID}&pn=QuickBite&tr=${order.id}&am=${total}&cu=INR&tn=Order_${shortOrderId}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(upiUrl)}`;

  console.log(`[CHECKOUT] Successfully generated payment links for Order ${shortOrderId}`);
  return { orderId: order.id, total, upiUrl, qrCodeUrl, upiId: UPI_ID };
}

// ---------------- ENDPOINTS ----------------

app.get("/api/menu", async (req, res) => {
  try {
    const { data: menu, error } = await supabase.from("menu").select("*").eq("is_available", true);
    if (error) throw error;
    res.json({ menu });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch menu", detail: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) return res.status(400).json({ error: "sessionId and message required" });
    const result = await processChatLogic(sessionId, message);
    res.json(result);
  } catch (err) {
    console.error("[API/CHAT ERROR] Returning 502 to frontend:", err.message);
    res.status(200).json({ error: "Gemini API error", detail: err.message });
  }
});

app.post("/api/checkout", async (req, res) => {
  try {
    const { sessionId, customerDetails } = req.body;
    const result = await processCheckoutLogic(sessionId, customerDetails);
    res.json(result);
  } catch (err) {
    console.error("[API/CHECKOUT ERROR] Returning 500 to frontend:", err.message);
    res.status(200).json({ error: "Checkout error", detail: err.message });
  }
});

app.post("/api/confirm-payment", async (req, res) => {
  try {
    const { orderId } = req.body;
    const { data: order, error } = await supabase
      .from("orders").update({ status: "PAID_CONFIRMED" }).eq("id", orderId).select().single();

    if (error) throw error;

    if (order.customer_email && order.customer_email.includes("@")) {
      const itemsList = (order.items || []).map(i => `<li>${i.qty}x <strong>${i.name}</strong> - ₹${i.price * i.qty}</li>`).join("");
      await resend.emails.send({
        from: process.env.SENDER_EMAIL || "onboarding@resend.dev",
        to: order.customer_email,
        subject: `Order Confirmed - QuickBite #${order.id.slice(0, 8)}`,
        html: `<div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
            <h2 style="color: #ffb100;">Order Confirmed! 🎉</h2>
            <p>Hi <strong>${order.customer_name}</strong>,</p>
            <p>Thank you for ordering with QuickBite. Your payment has been received!</p>
            <hr />
            <h3>Delivery Details:</h3>
            <p><strong>Address:</strong> ${order.delivery_address}<br/><strong>Phone:</strong> ${order.customer_phone}</p>
            <h3>Order Items:</h3>
            <ul>${itemsList}</ul>
            <p style="font-size: 16px;"><strong>Total Paid:</strong> ₹${order.total_amount}</p>
          </div>`
      });
    }

    carts.delete(order.session_id);
    customerSessions.delete(order.session_id);
    res.json({ status: "SUCCESS", message: "Payment confirmed.", order });
  } catch (err) {
    res.status(200).json({ error: "Confirmation failed", detail: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date() }));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));