const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
require("dotenv").config(); // Charger les variables d'environnement

const app = express();
app.use(express.json());
app.use(bodyParser.json());

// 📌 Dossier où stocker les QR codes
const QR_FOLDER = path.join(__dirname, "public/qrcodes");
if (!fs.existsSync(QR_FOLDER)) {
    fs.mkdirSync(QR_FOLDER, { recursive: true });
}

// 📌 Servir les QR codes via une URL publique
app.use("/qrcodes", express.static(QR_FOLDER));

const QR_FILE = process.env.QR_FILE || "./qrcodes.json";
let qrCache = {}; // Cache en mémoire

// 🔹 Charger les données JSON en mémoire au démarrage
const loadQRData = () => {
    try {
        const data = JSON.parse(fs.readFileSync(QR_FILE, "utf8"));
        qrCache = data.reduce((acc, qr) => {
            acc[qr.order_id] = qr;
            return acc;
        }, {});
        console.log(`[🔄] Cache chargé avec ${Object.keys(qrCache).length} QR codes.`);
    } catch (error) {
        console.error("[⚠️] Erreur lors du chargement du fichier JSON, création d'un nouveau fichier.");
        qrCache = {};
        saveQRData();
    }
};

// 🔹 Sauvegarde en JSON
const saveQRData = () => {
    fs.writeFileSync(QR_FILE, JSON.stringify(Object.values(qrCache), null, 2));
};

// 🔹 Chargement initial
loadQRData();

// 🔹 Configuration SMTP (Mailgun, Mailjet, etc.)
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false, // Utilise TLS
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

// 🔹 Fonction d'envoi d'email avec un QR Code hébergé
const sendEmailWithQR = async (email, orderId, qrUrl) => {
    const mailOptions = {
        from: process.env.SMTP_FROM,
        to: email,
        subject: `Votre QR Code pour la commande #${orderId}`,
        html: `
            <h2>Merci pour votre commande !</h2>
            <p>Voici votre QR code pour récupérer votre produit :</p>
            <img src="${qrUrl}" alt="QR Code">
            <p>Scannez ce code au point de retrait.</p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[📧] Email envoyé avec succès à ${email} pour la commande #${orderId}`);
    } catch (error) {
        console.error("[❌] Erreur lors de l'envoi de l'email :", error);
    }
};

// --- 1️⃣ Webhook Shopify : Génération d’un QR Code ---
app.post("/webhook-order", async (req, res) => {
    const order = req.body;
    let orderId = order.id.toString();
    const customerEmail = order.email;

    console.log(`[📥] Webhook reçu pour la commande #${orderId}`);

    const lineItems = order.line_items;
    console.log("[🔎] Produits reçus :", lineItems.map((item) => item.title));

    const tshirt = lineItems.find((item) => /qrtest/i.test(item.title));

    if (tshirt) {
        const qrFilePath = path.join(QR_FOLDER, `${orderId}.png`);
        await QRCode.toFile(qrFilePath, `${process.env.SERVER_URL}/scan?order_id=${orderId}`);

        const qrUrl = `${process.env.SERVER_URL}/qrcodes/${orderId}.png`;

        qrCache[orderId] = {
            order_id: orderId,
            product_name: tshirt.title,
            quantity: tshirt.quantity,
            status: "active",
            qr_code_url: qrUrl
        };
        saveQRData();

        console.log(`[✅] QR Code généré et hébergé pour la commande #${orderId}`);

        if (customerEmail) {
            await sendEmailWithQR(customerEmail, orderId, qrUrl);
        } else {
            console.log("[⚠️] Aucune adresse email trouvée pour cette commande.");
        }
    } else {
        console.log(`[ℹ️] Aucun produit concerné dans la commande #${orderId}, aucun QR code généré.`);
    }

    res.status(200).send("OK");
});

// --- 2️⃣ Interface web pour scanner les QR Codes ---
app.get("/scan", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Scan Commande</title>
        <script src="https://unpkg.com/html5-qrcode"></script>
    </head>
    <body>
        <h1>Scannez le QR Code</h1>
        <div id="reader" style="width:300px;"></div>
        <div id="result"></div>

        <script>
            let scanner;
            let isScanning = false; 
            let currentOrderId = null; 

            function onScanSuccess(decodedText) {
                if (isScanning) return;
                isScanning = true; 

                if (decodedText.includes("order_id=")) {
                    let orderId = decodedText.split("order_id=")[1];
                    currentOrderId = orderId;

                    fetch("/verify-qr?order_id=" + orderId)
                    .then(response => response.json())
                    .then(data => {
                        document.getElementById("result").innerHTML = 
                            '<h2>' + data.message + '</h2>' +
                            '<button onclick="validateScan()">Confirmer</button>';
                    })
                    .catch(err => {
                        console.error(err);
                        isScanning = false;
                    });

                } else {
                    document.getElementById("result").innerHTML = "<h2>Format de QR Code invalide !</h2>";
                    isScanning = false;
                }
            }

            function validateScan() {
                isScanning = false;
                currentOrderId = null;
                document.getElementById("result").innerHTML = "<h2>Scan validé. Vous pouvez scanner un nouveau QR code.</h2>";
            }

            scanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 });
            scanner.render(onScanSuccess);
        </script>
    </body>
    </html>
    `);
});

app.get("/verify-qr", (req, res) => {
  const { order_id } = req.query;
  if (!order_id) {
      return res.status(400).json({ error: "order_id requis" });
  }

  // Récupérer les infos de la commande dans qrCache
  const order = qrCache[order_id];
  if (!order) {
      console.log(`[❌] QR Code #${order_id} introuvable.`);
      return res.json({ status: "error", message: "QR Code introuvable !" });
  }

  // Vérifier si déjà "used"
  if (order.status === "used") {
      console.log(`[⚠️] QR Code déjà utilisé pour la commande #${order_id}`);
      return res.json({ status: "error", message: "QR Code déjà utilisé !" });
  }

  // Marquer comme utilisé
  order.status = "used";
  saveQRData();

  console.log(`[✅] QR Code validé pour la commande #${order_id}`);
  return res.json({
      status: "success",
      message: `Commande validée : ${order.product_name} x${order.quantity}`
  });
});

// Lancer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[🚀] Serveur lancé sur http://localhost:${PORT}`);
});
