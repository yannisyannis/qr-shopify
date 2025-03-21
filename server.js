const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const labels = require("./labels.json");
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

// 🔒 Système de file d'attente pour les sauvegardes
let saveQueue = [];
let isSaving = false;

const queueSave = () => {
  console.log(`📥 Sauvegarde demandée. File d'attente actuelle : ${saveQueue.length + 1}`);
  return new Promise((resolve, reject) => {
      saveQueue.push({ resolve, reject });
      processQueue();
  });
};

const processQueue = async () => {
  if (isSaving || saveQueue.length === 0) return;

  isSaving = true;
  const { resolve, reject } = saveQueue.shift();
  const saveId = Date.now(); // Pour suivi

  console.log(`🕒 [${saveId}] Début de sauvegarde. File : ${saveQueue.length}`);

  try {
      await saveQRData();
      console.log(`✅ [${saveId}] Sauvegarde terminée.`);
      resolve();
  } catch (err) {
      console.error(`❌ [${saveId}] Échec sauvegarde :`, err);
      reject(err);
  } finally {
      isSaving = false;
      setImmediate(processQueue);
  }
};

// 🔹 Charger les données JSON en mémoire au démarrage
const loadQRData = async () => {
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
        await queueSave();
    }
};

// 🔹 Sauvegarde en JSON
const saveQRData = async () => {
  console.log("📝 Écriture du fichier JSON...");
  await fs.promises.writeFile(QR_FILE, JSON.stringify(Object.values(qrCache), null, 2));
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

    const product_target = lineItems.find((item) => /qrtest/i.test(item.title));

    if (product_target) {
        const qrFilePath = path.join(QR_FOLDER, `${orderId}.png`);
        await QRCode.toFile(qrFilePath, `${process.env.SERVER_URL}/scan?order_id=${orderId}`);

        const qrUrl = `${process.env.SERVER_URL}/qrcodes/${orderId}.png`;

        qrCache[orderId] = {
            order_id: orderId,
            customer_name: order.customer?.first_name + " " + order.customer?.last_name || "Client",
            product_name: product_target.title,
            quantity: product_target.quantity,
            status: "active",
            qr_code_url: qrUrl
        };
        await queueSave();

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
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>${labels.page_title}</title>
  <script src="https://unpkg.com/html5-qrcode"></script>
  <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Arial', sans-serif; }
        html, body {
            width: 100%; height: 100%;
            display: flex; flex-direction: column;
            justify-content: space-between; align-items: center;
            background: linear-gradient(to bottom, #f4f4f4, #eaeaea);
            text-align: center; padding: 10px;
        }
        .hidden {
            display: none !important;
        }
        #scanner-container {
            display: flex; flex-direction: column;
            align-items: center; width: 100%;
            flex: 1; margin: 10px;
        }
        #reader {
            width: 100%; 
            aspect-ratio: 1; background: white;
            padding: 10px; border-radius: 10px;
        }
        #reader>video {
            width: 100% !important;
        }   
        #info-box {
            width: 100%; max-width: 350px;
            background: white; padding: 15px;
            border-radius: 10px;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
            text-align: center;
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }
        #status {
            font-size: 18px; font-weight: bold;
            padding: 10px; border-radius: 8px;
            text-align: center; transition: opacity 0.3s ease-in-out;
        }
        .valid { background-color: #28a745; color: white; }
        .invalid { background-color: #dc3545; color: white; }
        #details {
            font-size: 16px; margin-top: 10px;
            background: #f8f9fa; padding: 10px;
            border-radius: 5px; border: 1px solid #ddd;
            text-align: left; width: 100%; max-width: 320px;
            display: none;
        }
        #confirmButton {
            padding: 14px 20px; margin-top: 15px;
            border: none; background: #007bff; color: white;
            font-size: 16px; cursor: pointer;
            border-radius: 8px; width: 100%; max-width: 320px;
            font-weight: bold; transition: background 0.3s ease, transform 0.1s;
            display: none;
        }
        #confirmButton:hover { background: #0056b3; }
        #confirmButton:active { transform: scale(0.98); }
        #cameraSelect {
            margin: 10px 0;
            padding: 8px;
            font-size: 16px;
            border-radius: 5px;
            border: 1px solid #ccc;
            max-width: 320px;
            width: 100%;
        }
        @keyframes shake {
            0% { transform: translateX(0); }
            20% { transform: translateX(-5px); }
            40% { transform: translateX(5px); }
            60% { transform: translateX(-5px); }
            80% { transform: translateX(5px); }
            100% { transform: translateX(0); }
        }

        .shake {
            animation: shake 0.4s ease;
        }

        @keyframes pulse-valid {
            0%   { transform: scale(1); background-color: #28a745; }
            50%  { transform: scale(1.05); background-color: #34c759; }
            100% { transform: scale(1); background-color: #28a745; }
        }

        .pulse {
            animation: pulse-valid 0.5s ease;
        }

    </style>
</head>
<body>
  <h1>${labels.header_title}</h1>

  <div id="scanner-container">
    <select id="cameraSelect"></select>
    <div id="reader"></div>
  </div>

  <div id="info-box">
    <div id="status">${labels.status_default}</div>
    <div id="details"></div>
    <button id="confirmButton" onclick="validateScan()">${labels.button_confirm}</button>
  </div>

  <script>
    let html5QrCode;
    let isScanning = false;
    let selectedDeviceId = localStorage.getItem("preferredCameraId");
    let currentOrderId = null;
    let lastScanTime = 0;

    function startScanner(deviceId) {
      const config = { fps: 10, qrbox: 250 };
      html5QrCode = new Html5Qrcode("reader");
      html5QrCode.start(deviceId, config, onScanSuccess)
        .catch(err => console.error("Erreur lors du démarrage du scanner :", err));
    }

    function onScanSuccess(decodedText) {
      const now = Date.now();
      if (now - lastScanTime < 1000) return;
      lastScanTime = now;

      if (isScanning) return;
      isScanning = true;

      if (decodedText.includes("order_id=")) {
        let orderId = decodedText.split("order_id=")[1];

        fetch("/verify-qr?order_id=" + orderId)
          .then(response => response.json())
          .then(data => {
            let statusDiv = document.getElementById("status");
            let detailsDiv = document.getElementById("details");
            let confirmButton = document.getElementById("confirmButton");

            if (data.status === "success") {
              currentOrderId = orderId;
              statusDiv.innerText = "${labels.status_valid}";
              statusDiv.className = "valid";
              detailsDiv.innerHTML =
                "<strong>${labels.label_name}:</strong> " + data.customer_name + "<br>" +
                "<strong>${labels.label_product}:</strong> " + data.product_name + "<br>" +
                "<strong>${labels.label_quantity}:</strong> " + data.quantity;
              confirmButton.style.display = "block";
              detailsDiv.style.display = "block";
              document.getElementById("scanner-container").classList.add("hidden");
              statusDiv.classList.add("pulse");
              setTimeout(() => statusDiv.classList.remove("pulse"), 500);
            } else {
              statusDiv.innerText = "${labels.status_invalid}";
              statusDiv.className = "invalid";
              detailsDiv.innerHTML = "";
              detailsDiv.style.display = "none";
              confirmButton.style.display = "none";
              isScanning = false;
              statusDiv.classList.add("shake");
              setTimeout(() => statusDiv.classList.remove("shake"), 400);
            }
          })
          .catch(err => {
            console.error(err);
            let statusDiv = document.getElementById("status");
            statusDiv.innerText = "${labels.status_error}";
            statusDiv.className = "invalid";
            detailsDiv.style.display = "none";
            isScanning = false;
          });
      } else {
        document.getElementById("status").innerText = "${labels.status_invalid_format}";
        document.getElementById("status").className = "invalid";
        isScanning = false;
      }
    }

    function validateScan() {
      if (!currentOrderId) return;

      fetch("/confirm-qr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: currentOrderId })
      })
      .then(res => res.json())
      .then(result => {
        if (result.success) {
          isScanning = false;
          document.getElementById("confirmButton").style.display = "none";
          document.getElementById("status").innerText = "${labels.status_confirmed}";
          document.getElementById("status").className = "valid";
          document.getElementById("details").innerHTML = "";
          document.getElementById("details").style.display = "none";
          document.getElementById("scanner-container").classList.remove("hidden");
          currentOrderId = null;
        }
      })
      .catch(err => {
        console.error("Erreur lors de la confirmation :", err);
      });
    }

    Html5Qrcode.getCameras().then(devices => {
      const select = document.getElementById("cameraSelect");
      select.innerHTML = "";
      devices.forEach(device => {
        let option = document.createElement("option");
        option.value = device.id;
        option.text = device.label || "${labels.camera_label} " + (select.length + 1);
        select.appendChild(option);
      });

      if (selectedDeviceId && devices.some(d => d.id === selectedDeviceId)) {
        select.value = selectedDeviceId;
        startScanner(selectedDeviceId);
      }

      select.addEventListener("change", function () {
        localStorage.setItem("preferredCameraId", this.value);
        if (html5QrCode) html5QrCode.stop().then(() => {
          document.getElementById("reader").innerHTML = "";
          startScanner(this.value);
        });
      });

      if (!selectedDeviceId && devices.length > 0) {
        startScanner(devices[0].id);
      }
    }).catch(err => console.error("Impossible d'accéder aux caméras", err));
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

  // Vérifier si l'ID est bien enregistré
  const order = qrCache[order_id];
  if (!order) {
      console.log(`[❌] QR Code #${order_id} introuvable.`);
      return res.json({ status: "error", message: "QR Code introuvable !" });
  }

  // Vérifier si déjà utilisé
  if (order.status === "used") {
      console.log(`[⚠️] QR Code déjà utilisé pour la commande #${order_id}`);
      return res.json({ status: "error", message: "QR Code déjà utilisé !" });
  }

  console.log(`[✅] QR Code validé pour la commande #${order_id}`);
  console.log("➡️ Données envoyées :", {
      status: "success",
      customer_name: order.customer_name,
      product_name: order.product_name,
      quantity: order.quantity
  });

  return res.json({
      status: "success",
      customer_name: order.customer_name,
      product_name: order.product_name,
      quantity: order.quantity
  });
});

app.post("/confirm-qr", async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) {
      return res.status(400).json({ error: "order_id requis" });
  }

  const order = qrCache[order_id];
  if (!order || order.status === "used") {
      return res.status(400).json({ error: "Code introuvable ou déjà utilisé." });
  }

  order.status = "used";
  await queueSave();

  console.log(`[🔒] QR Code confirmé pour la commande #${order_id}`);
  res.json({ success: true });
});


// Lancer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[🚀] Serveur lancé sur http://localhost:${PORT}`);
});
