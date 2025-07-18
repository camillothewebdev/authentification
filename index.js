const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");
const express = require("express");
const cors = require("cors");
const fs = require("fs-extra");
const fetch = require("node-fetch"); // Add this

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

let sock;
let loginQR = null;
let connected = false;
const verificationList = [];

async function connectToWhatsAppAccount() {
  const { state, saveCreds: save } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state });
  sock.ev.on("creds.update", save);
  sock.ev.on("connection.update", handleConnectionUpdate);
}

function handleConnectionUpdate({ connection, qr }) {
  if (qr) {
    qrcode.toDataURL(qr).then(url => {
      loginQR = url;
    });
    console.log("🔒 Scan the QR");
  }

  if (connection === "open") {
    connected = true;
    loginQR = null;
    console.log("✅ Connected to WhatsApp");
  }

  if (connection === "close") {
    console.log("🔁 Reconnecting...");
    connectToWhatsAppAccount();
  }
}

function removeOldAuthFolder() {
  fs.removeSync("auth_info");
  console.log("📁 Auth folder removed");
}

app.post("/send-code", async (req, res) => {
  const jid = req.body.number + "@s.whatsapp.net";
  const exists = await sock.onWhatsApp(jid);
  if (!exists.length)
    return res.json({
      success: false,
      error: "Ce numero n'est pas sur Whatsapp",
    });

  const otp = Math.floor(1000 + Math.random() * 9000);
  verificationList.unshift({ number: req.body.number, otp: otp, expired: false });

  setTimeout(() => {
    const index = verificationList.findIndex(
      (v) => v.number === req.body.number && v.otp === otp
    );
    if (index !== -1) verificationList[index].expired = true;
  }, 2 * 60 * 1000);

  await sock.sendMessage(jid, { text: `Votre code est : *${otp}*` });
  console.log("📩 Message sent");
  res.json({ success: true });
});

app.post("/verify-code", (req, res) => {
  const { number, otp } = req.body;
  const index = verificationList.findIndex((v) => v.number === number);

  if (index === -1) return res.json({ success: false, error: "Code non envoyé" });

  if (verificationList[index].otp == otp) {
    if (verificationList[index].expired) {
      res.json({ success: false, message: "Le code a expiré" });
    } else {
      res.json({ success: true, message: "Le code est correct" });
    }
  } else {
    res.json({ success: false, message: "Le code est incorrect" });
  }
});

app.get("/get-login-qr", (req, res) => {
  if (loginQR) res.json({ success: true, qr: loginQR });
  else res.json({ success: false });
});

app.get("/connected", (req, res) => {
  res.json({ connected: connected });
});

app.get("/wake-up", (req, res) => {
  res.json({ awake: true });
});

removeOldAuthFolder();
connectToWhatsAppAccount();

setInterval(() => {
  fetch("https://congosoft-auth.onrender.com/wake-up").catch(() => {});
}, 5 * 60 * 1000); // Ping every 5 minutes

app.listen(8080, () => console.log("🚀 Server running on port 8080"));
