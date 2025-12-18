require("dotenv").config();
const { Telegraf } = require("telegraf");
const axios = require("axios");
const mongoose = require("mongoose");
// EXPRESS SETUP
const express = require("express");

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Bot is alive!");
});

// START EXPRESS SERVER
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// MONGODB SETUP
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB Connection Error:", err));

// Define a simple Schema for the User
const UserSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  firstName: String,
  favorites: [String], // We will store Coin IDs here (e.g. ['bitcoin', 'ethereum'])
});

const User = mongoose.model("User", UserSchema);
const bot = new Telegraf(process.env.BOT_TOKEN);

// IN-MEMORY CACHE
// We will store 'btc' -> 'bitcoin', 'eth' -> 'ethereum' here
const coinMap = new Map();

// INITIALIZATION FUNCTION
async function initCoinList() {
  try {
    console.log("Fetching coin list... (This takes a few seconds)");
    const { data } = await axios.get(
      "https://api.coingecko.com/api/v3/coins/list"
    );

    // Loop through the massive list and map Symbol -> ID
    data.forEach((coin) => {
      // coin.symbol is usually lowercase, e.g., 'btc'
      // We map 'btc' -> 'bitcoin'
      coinMap.set(coin.symbol.toLowerCase(), coin.id);
    });

    console.log(`Loaded ${coinMap.size} coins into memory!`);
  } catch (error) {
    console.error("Failed to load coin list:", error.message);
  }
}

// --- 3. HELPER: Get User from DB ---
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

bot.start((ctx) => {
  ctx.reply(
    "Welcome! \n\n" +
      "Commands:\n" +
      "/price <symbol> - Check one price\n" +
      "/add <symbol> - Add to watch-list\n" +
      "/watchlist - See your portfolio\n" +
      "/remove <symbol> - Remove from watch-list"
  );
});

// COMMAND: /add btc
bot.command("add", async (ctx) => {
  // FIX: Use split() to get the text after the command
  const parts = ctx.message.text.split(" ");
  const rawInput = parts[1]; // Get the second part (the symbol)

  if (!rawInput) return ctx.reply("Please provide a symbol. Ex: /add btc");

  const inputLower = rawInput.toLowerCase();

  // Resolve symbol to ID (btc -> bitcoin)
  const coinId = coinMap.has(inputLower) ? coinMap.get(inputLower) : inputLower;

  try {
    const user = await getUser(ctx);

    // Prevent duplicates
    if (user.favorites.includes(coinId)) {
      return ctx.reply(`You are already watching ${coinId.toUpperCase()}.`);
    }

    user.favorites.push(coinId);
    await user.save();

    ctx.reply(`Added <b>${coinId}</b> to your watch-list!`, {
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error(err);
    ctx.reply("Database error.");
  }
});

// COMMAND: /watch-list
bot.command("watchlist", async (ctx) => {
  const user = await getUser(ctx);

  if (user.favorites.length === 0) {
    return ctx.reply("Your watch-list is empty. Use /add btc to start.");
  }

  try {
    ctx.reply("Fetching prices...");

    // CoinGecko allows comma-separated IDs: "bitcoin,ethereum,Solana"
    const ids = user.favorites.join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;

    const { data } = await axios.get(url);

    let message = "<b>Your Watch-list:</b>\n\n";

    user.favorites.forEach((coinId) => {
      if (data[coinId]) {
        const price = data[coinId].usd;
        message += `• ${coinId.toUpperCase()}: <b>$${price.toLocaleString()}</b>\n`;
      }
    });

    ctx.reply(message, { parse_mode: "HTML" });
  } catch (error) {
    console.error(error);
    ctx.reply("API Error fetching watch-list.");
  }
});

// COMMAND: /price (Kept for quick checks)
bot.command("price", async (ctx) => {
  // 1. safer way to get input in Telegraf
  // splits "/price btc" into ["/price", "btc"] and takes the second part
  const rawInput = ctx.message.text.split(" ")[1];

  if (!rawInput) return ctx.reply("Ex: /price btc");

  const inputLower = rawInput.toLowerCase();

  // Check our map: if user typed 'btc', get 'bitcoin'. If not, use input as is.
  const coinId = coinMap.has(inputLower) ? coinMap.get(inputLower) : inputLower;

  try {
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`
    );

    if (!data[coinId]) {
      return ctx.reply("Coin not found.");
    }

    ctx.reply(`${coinId.toUpperCase()}: $${data[coinId].usd.toLocaleString()}`);
  } catch (error) {
    // We explicitly name it 'error' here
    console.error(error); // Log the actual error object
    ctx.reply("API Error");
  }
});

// COMMAND: /remove
bot.command("remove", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const rawInput = parts[1];

  if (!rawInput) return ctx.reply("Ex: /remove btc");

  const inputLower = rawInput.toLowerCase();
  const coinId = coinMap.has(inputLower) ? coinMap.get(inputLower) : inputLower;

  try {
    const user = await getUser(ctx);

    // Check if coin exists in favorites
    if (!user.favorites.includes(coinId)) {
      return ctx.reply(`${coinId} is not in your watch-list.`);
    }

    // Filter it out (Create a new array without that coin)
    user.favorites = user.favorites.filter((id) => id !== coinId);
    await user.save();

    ctx.reply(`Removed <b>${coinId}</b> from your watch-list.`, {
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error(err);
    ctx.reply("Database error.");
  }
});

// Run initCoinList BEFORE launching the bot
initCoinList().then(() => {
  bot.launch();
  console.log("Bot is running...");
});

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));


