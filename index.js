require("dotenv").config();
const { Telegraf } = require("telegraf");
const axios = require("axios");
const mongoose = require("mongoose");
const express = require("express");

const app = express();
const port = process.env.PORT || 3000;

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "alive",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    bot: "running",
    database:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// MONGODB SETUP with better error handling
mongoose
  .connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err);
    process.exit(1);
  });

mongoose.connection.on("error", (err) => {
  console.error("MongoDB error:", err);
});

// User Schema
const UserSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  firstName: String,
  favorites: [String],
  alerts: [
    {
      coinId: String,
      targetPrice: Number,
      direction: String,
    },
  ],
});

const User = mongoose.model("User", UserSchema);
const bot = new Telegraf(process.env.BOT_TOKEN);

const coinMap = new Map();

// Initialize coin list with better error handling
async function initCoinList() {
  try {
    console.log("Fetching coin list...");
    const { data } = await axios.get(
      "https://api.coingecko.com/api/v3/coins/list",
      { timeout: 10000 } // 10 second timeout
    );

    data.forEach((coin) => {
      coinMap.set(coin.symbol.toLowerCase(), coin.id);
    });

    console.log(`✅ Loaded ${coinMap.size} coins into memory!`);
  } catch (error) {
    console.error("❌ Failed to load coin list:", error.message);
    throw error; // Propagate error
  }
}

// Helper: Get User from DB
async function getUser(ctx) {
  let user = await User.findOne({ telegramId: ctx.from.id.toString() });
  if (!user) {
    user = new User({
      telegramId: ctx.from.id.toString(),
      firstName: ctx.from.first_name,
      favorites: [],
    });
    await user.save();
  }
  return user;
}

// Commands
bot.start((ctx) => {
  ctx.reply(
    "Welcome! 🚀\n\n" +
      "Commands:\n" +
      "/price <symbol> - Check one price\n" +
      "/add <symbol> - Add to watch-list\n" +
      "/watchlist - See your portfolio\n" +
      "/remove <symbol> - Remove from watch-list\n" +
      "/alert <symbol> <price> - Set price alert"
  );
});

bot.command("add", async (ctx) => {
  try {
    const parts = ctx.message.text.split(" ");
    const rawInput = parts[1];

    if (!rawInput) return ctx.reply("Please provide a symbol. Ex: /add btc");

    const inputLower = rawInput.toLowerCase();
    const coinId = coinMap.has(inputLower)
      ? coinMap.get(inputLower)
      : inputLower;

    const user = await getUser(ctx);

    if (user.favorites.includes(coinId)) {
      return ctx.reply(`You are already watching ${coinId.toUpperCase()}.`);
    }

    user.favorites.push(coinId);
    await user.save();

    ctx.reply(`✅ Added <b>${coinId}</b> to your watch-list!`, {
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("Add command error:", err);
    ctx.reply("❌ Failed to add coin. Please try again.");
  }
});

bot.command("watchlist", async (ctx) => {
  try {
    const user = await getUser(ctx);

    if (user.favorites.length === 0) {
      return ctx.reply("Your watch-list is empty. Use /add btc to start.");
    }

    ctx.reply("Fetching prices...");

    const ids = user.favorites.join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;

    const { data } = await axios.get(url, { timeout: 10000 });

    let message = "<b>📊 Your Watch-list:</b>\n\n";

    user.favorites.forEach((coinId) => {
      if (data[coinId]) {
        const price = data[coinId].usd;
        message += `• ${coinId.toUpperCase()}: <b>$${price.toLocaleString()}</b>\n`;
      }
    });

    ctx.reply(message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Watchlist error:", error);
    if (error.response?.status === 429) {
      return ctx.reply("⏳ Rate limit exceeded. Try again in a few minutes.");
    }
    ctx.reply("❌ Failed to fetch watchlist.");
  }
});

bot.command("price", async (ctx) => {
  try {
    const rawInput = ctx.message.text.split(" ")[1];

    if (!rawInput) return ctx.reply("Ex: /price btc");

    const inputLower = rawInput.toLowerCase();
    const coinId = coinMap.has(inputLower)
      ? coinMap.get(inputLower)
      : inputLower;

    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      { timeout: 10000 }
    );

    if (!data[coinId]) {
      return ctx.reply("Coin not found.");
    }

    ctx.reply(
      `💰 ${coinId.toUpperCase()}: $${data[coinId].usd.toLocaleString()}`
    );
  } catch (error) {
    console.error("Price error:", error);
    if (error.response?.status === 429) {
      return ctx.reply("⏳ Rate limit exceeded. Try again later.");
    }
    ctx.reply("❌ API Error");
  }
});

bot.command("remove", async (ctx) => {
  try {
    const parts = ctx.message.text.split(" ");
    const rawInput = parts[1];

    if (!rawInput) return ctx.reply("Ex: /remove btc");

    const inputLower = rawInput.toLowerCase();
    const coinId = coinMap.has(inputLower)
      ? coinMap.get(inputLower)
      : inputLower;

    const user = await getUser(ctx);

    if (!user.favorites.includes(coinId)) {
      return ctx.reply(`${coinId} is not in your watch-list.`);
    }

    user.favorites = user.favorites.filter((id) => id !== coinId);
    await user.save();

    ctx.reply(`✅ Removed <b>${coinId}</b> from your watch-list.`, {
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("Remove error:", err);
    ctx.reply("❌ Database error.");
  }
});

bot.command("alert", async (ctx) => {
  try {
    const parts = ctx.message.text.split(" ");
    const rawCoin = parts[1];
    const targetPrice = parseFloat(parts[2]);

    if (!rawCoin || !targetPrice) {
      return ctx.reply(
        "Usage: /alert <symbol> <price>\nExample: /alert btc 90000"
      );
    }

    const inputLower = rawCoin.toLowerCase();
    const coinId = coinMap.has(inputLower)
      ? coinMap.get(inputLower)
      : inputLower;

    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      { timeout: 10000 }
    );

    if (!data[coinId]) return ctx.reply("Coin not found.");

    const currentPrice = data[coinId].usd;
    const direction = targetPrice > currentPrice ? "above" : "below";

    const user = await getUser(ctx);
    user.alerts.push({
      coinId,
      targetPrice,
      direction,
    });
    await user.save();

    ctx.reply(
      `🔔 Alert Set!\nI will message you when <b>${coinId}</b> goes <b>${direction} $${targetPrice}</b>.`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("Alert error:", err);
    ctx.reply("❌ Error setting alert.");
  }
});

// Background job - Check every 5 minutes (not 1 minute!)
setInterval(async () => {
  try {
    const users = await User.find({ "alerts.0": { $exists: true } });
    if (users.length === 0) return;

    const coinSet = new Set();
    users.forEach((u) => u.alerts.forEach((a) => coinSet.add(a.coinId)));

    const ids = Array.from(coinSet).join(",");
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { timeout: 10000 }
    );

    for (const user of users) {
      let alertTriggered = false;
      const remainingAlerts = [];

      for (const alert of user.alerts) {
        const price = data[alert.coinId]?.usd;
        if (!price) {
          remainingAlerts.push(alert);
          continue;
        }

        let fired = false;
        if (alert.direction === "above" && price >= alert.targetPrice)
          fired = true;
        if (alert.direction === "below" && price <= alert.targetPrice)
          fired = true;

        if (fired) {
          await bot.telegram.sendMessage(
            user.telegramId,
            `<b>🚨 ALERT TRIGGERED!</b>\n\n${alert.coinId.toUpperCase()} has reached <b>$${price}</b>\n(Target: ${alert.direction} $${alert.targetPrice})`,
            { parse_mode: "HTML" }
          );
          alertTriggered = true;
        } else {
          remainingAlerts.push(alert);
        }
      }

      if (alertTriggered) {
        user.alerts = remainingAlerts;
        await user.save();
      }
    }
  } catch (e) {
    console.error("Checker Error:", e.message);
  }
}, 300000); // 5 minutes instead of 1 minute

// Set bot commands
bot.telegram.setMyCommands([
  { command: "start", description: "Restart the bot" },
  { command: "price", description: "Check coin price" },
  { command: "watchlist", description: "View your watchlist" },
  { command: "add", description: "Add coin to watchlist" },
  { command: "remove", description: "Remove coin from watchlist" },
  { command: "alert", description: "Set price alert" },
]);

// Start server and bot
const server = app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});

// Initialize and launch bot
initCoinList()
  .then(() => {
    bot.launch();
    console.log("✅ Bot is running...");
  })
  .catch((error) => {
    console.error("❌ Failed to start bot:", error);
    process.exit(1);
  });

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  bot.stop(signal);
  await mongoose.connection.close();

  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error("❌ Forced shutdown");
    process.exit(1);
  }, 10000);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
