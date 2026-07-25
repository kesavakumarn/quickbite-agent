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
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const UPI_ID = process.env.UPI_ID || "kesavakumarn-2@okicici";

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_ANON_KEY || ""
);

// Initialize Resend Email Client
const resend = new Resend(process.env.RESEND_API_KEY || "");

// In-memory sessions cart (session_id -> items array)
const carts = new Map();

function getCart(sessionId) {
  if (!carts.has(sessionId)) carts.set(sessionId, []);
  return carts.get(sessionId);
}

function calculateTotal(cart) {
  return cart.reduce((sum, item) => sum + item.price * item.qty, 0);
}

// ---------------- ENDPOINTS ----------------

// 1. Fetch Dynamic Menu from Supabase DB
app.get("/api/menu", async (req, res) => {
  try {
    const { data: menu, error } = await supabase.from("menu").select("*").eq("is_available", true);
    if (error) throw error;
    res.json({ menu });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch menu", detail: err.message });
  }
});

// 2. Chat Endpoint (Gemini AI Agent)
app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
      return res.status(400).json({ error: "sessionId and message are required" });
    }

    const cart = getCart(sessionId);

    // Dynamic Menu fetch for AI context
    const { data: menuItems } = await supabase.from("menu").select("*").eq("is_available", true);
    const menuContext = (menuItems || [])
      .map((m) => `${m.name} (ID: ${m.id}) - ₹${m.price} - ${m.description}`)
      .join("\n");

    const systemPrompt = `You are a polite food ordering assistant for "QuickBite".
Available Dynamic Menu:
${menuContext}

Current Cart: ${cart.length ? JSON.stringify(cart) : "empty"}

Task Instructions:
1. Help the user add/remove menu items.
2. Politely collect four mandatory delivery details from the customer before completing checkout:
   - Full Name
   - Phone Number
   - Delivery Address
   - Email Address
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

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: "Gemini API error", detail: errText });
    }

    const data = await resp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { reply: rawText, cart_actions: [], customer_details: {}, ready_to_checkout: false };
    }

    // Process Cart Actions Server-Side
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
        if (existing.qty <= 0) {
          const idx = cart.indexOf(existing);
          cart.splice(idx, 1);
        }
      }
    }

    res.json({
      reply: parsed.reply || "How can I help with your order?",
      cart,
      total: calculateTotal(cart),
      customerDetails: parsed.customer_details || {},
      readyToCheckout: !!parsed.ready_to_checkout,
    });
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error", detail: err.message });
  }
});

// 3. Checkout: Create Order Record in Supabase DB & Generate UPI Link
app.post("/api/checkout", async (req, res) => {
  try {
    const { sessionId, customerDetails } = req.body;
    const cart = getCart(sessionId);

    if (!cart.length) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const total = calculateTotal(cart);

    // Save persistent order into Supabase
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

    // Build Deep Link for Google Pay / UPI
    const shortOrderId = order.id.slice(0, 8);
    const upiUrl = `upi://pay?pa=${UPI_ID}&pn=QuickBite&tr=${order.id}&am=${total}&cu=INR&tn=Order_${shortOrderId}`;
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(upiUrl)}`;

    res.json({
      orderId: order.id,
      total,
      upiUrl,
      qrCodeUrl,
      upiId: UPI_ID,
    });
  } catch (err) {
    res.status(500).json({ error: "Checkout error", detail: err.message });
  }
});

// 4. Confirm Payment & Trigger Email
app.post("/api/confirm-payment", async (req, res) => {
  try {
    const { orderId } = req.body;

    // Update status in Supabase
    const { data: order, error } = await supabase
      .from("orders")
      .update({ status: "PAID_CONFIRMED" })
      .eq("id", orderId)
      .select()
      .single();

    if (error) throw error;

    // Send Confirmation Email via Resend
    if (order.customer_email && order.customer_email.includes("@")) {
      const itemsList = (order.items || [])
        .map((i) => `<li>${i.qty}x <strong>${i.name}</strong> - ₹${i.price * i.qty}</li>`)
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

    // Clear cart session
    carts.delete(order.session_id);

    res.json({ status: "SUCCESS", message: "Payment confirmed and notification email dispatched.", order });
  } catch (err) {
    res.status(500).json({ error: "Confirmation failed", detail: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date() }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
