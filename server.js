const qrcode = require("qrcode");
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const crypto = require("crypto");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(cookieParser());

const sessions = {};
const otpStore = {};
const OTP_EXPIRY_MS = 2 * 60 * 1000;
const PORT = 3000;
let connectedToWhatsapp = false;

app.use((req, res, next) => {
  const sessionId = req.cookies.sessionId;
  const loggedIn = sessionId && sessions[sessionId];
  const blockedPaths = ["/", "/index.html", "/verification.html"];

  if (loggedIn && blockedPaths.includes(req.path)) {
    return res.redirect("/welcome.html");
  }
  if (!loggedIn && req.path == "/welcome.html") {
    return res.redirect("/index.html");
  }
  next();
});

app.use(express.static("public"));

let sock;
let latestQr = null;

async function demarrerBaileys() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      console.log("Scannez ce QR code avec WhatsApp :");
      console.log(await qrcode.toString(qr, { small: true }));
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connecté");
      connectedToWhatsapp = true;
    }

    if (connection === "close") {
      console.log("Connexion fermée. Reconnexion :", connectedToWhatsapp);
      if (!connectedToWhatsapp) {
        await demarrerBaileys();
      } else {
        console.log("❌ Auth échouée. Rescanner QR manuellement.");
      }
    }
  });
}
demarrerBaileys();

function genererOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function genererSessionId() {
  return crypto.randomBytes(16).toString("hex");
}

app.get("/wake-up", async (req, res) => {
  return res.json({ text: "i am awake" });
});

app.post("/send-code", async (req, res) => {
  const { number } = req.body;
  if (!number) return res.json({ error: "Numéro requis" });

  try {
    const check = await sock.onWhatsApp(number + "@s.whatsapp.net");
    if (!check[0]?.exists) {
      return res.json({
        error: "Ce numéro n'est pas sur WhatsApp.",
      });
    }

    const otp = genererOTP();
    otpStore[number] = { otp, createdAt: Date.now() };

    await sock.sendMessage(number + "@s.whatsapp.net", {
      text:
        "```Congosoft```\n➖➖➖➖\n\nVotre code est : \n*" +
        otp +
        "*\n\n> Expire dans 2 minutes`",
    });
    console.log(`OTP ${otp} envoyé à ${number}`);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.json({ error: "Erreur lors de l'envoi du code" });
  }
});

app.post("/verify-code", (req, res) => {
  const { number, otp } = req.body;
  if (!number || !otp) return res.json({ error: "Numéro et Code sont requis" });

  const record = otpStore[number];
  if (!record) return res.json({ error: "Aucun Code envoyé pour ce numéro" });

  if (Date.now() - record.createdAt > OTP_EXPIRY_MS) {
    delete otpStore[number];
    return res.json({ error: "Code expiré" });
  }

  if (record.otp !== otp) return res.json({ error: "Code invalide" });

  delete otpStore[number];
  const sessionId = genererSessionId();
  sessions[sessionId] = number;

  res.cookie("sessionId", sessionId, {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({ success: true });
});

app.get("/logout", (req, res) => {
  const sessionId = req.cookies.sessionId;
  if (sessionId) delete sessions[sessionId];
  res.clearCookie("sessionId");
  res.redirect("/index.html");
});

function authMiddleware(req, res, next) {
  const sessionId = req.cookies.sessionId;
  if (sessionId && sessions[sessionId]) {
    req.number = sessions[sessionId];
    next();
  } else {
    res.redirect("/index.html");
  }
}

app.get("/welcome.html", authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "welcome.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve QR in browser
app.get("/qr", async (req, res) => {
  if (!latestQr || connectedToWhatsapp) return res.json({ qr: false });
  const qrImage = await qrcode.toDataURL(latestQr);
  return res.json({ qr: true, qrImage: qrImage });
});

app.get("/is-connected", async (req, res) => {
  if (connectedToWhatsapp) {
    res.json({ connected: true });
  } else {
    res.json({ connected: false });
  }
});

app.listen(PORT, () =>
  console.log(`Serveur lancé sur http://localhost:${PORT}`)
);
