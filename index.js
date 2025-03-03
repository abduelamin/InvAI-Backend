import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { PromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import pool from "./db.js";
import cors from "cors";
import aiRoutes from "./Routes/ai.js";
import compression from "compression";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: "https://inv-ai.vercel.app",
    credentials: true,
  })
);
console.log("Environment:", process.env.NODE_ENV);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  compression({
    // Important: Disable compression for SSE
    filter: (req, res) => {
      if (
        req.headers.accept &&
        req.headers.accept.includes("text/event-stream")
      ) {
        return false;
      }
      return compression.filter(req, res);
    },
  })
);

// Rate limiting this has been moved to specifc route in ai that doesnt use streaming. stresming seems harder to integrate rate limitng with so i need to learn how to do it.//

// const limiter = rateLimit({
//   windowMs: 10 * 60 * 1000,
//   max: 4,
//   message: {
//     error: "Too many requests to AI, please try again after 10 minutes",
//   },
//   standardHeaders: true,
//   legacyHeaders: false,
// });
app.set("trust proxy", 1);

/* ROUTES: */

// Displaying Inventory
app.get("/api/stockoverview", async (req, res) => {
  try {
    const getStockData = await pool.query("SELECT * FROM product_details_view");

    res.status(200).json(getStockData);
  } catch (error) {
    console.error(error.message);
  }
});

// Creating new product
app.post("/api/addproduct", async (req, res) => {
  const {
    product_name,
    strength,
    form,
    reorder_threshold,
    supplier_lead_time,
  } = req.body;

  const newProduct = await pool.query(
    "INSERT INTO product_inventory (product_name, strength, form, reorder_threshold, supplier_lead_time) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [product_name, strength, form, reorder_threshold, supplier_lead_time]
  );

  res.status(201).json(newProduct);
});

app.post("/api/addbatch", async (req, res) => {
  const { product_name, strength, batch_number, current_stock, expiry_date } =
    req.body;

  if (!product_name || !strength)
    return res.status(400).json("Missing product name or strength");

  try {
    const productID = await pool.query(
      "SELECT product_id, strength FROM product_inventory WHERE product_name = $1 AND strength = $2",
      [product_name, strength]
    );
    if (productID.rows.length === 0)
      return res
        .status(404)
        .json(
          "Product do not exist in the database. Please add new product before creating a batch for it."
        );

    const doesBatchNumberExist = await pool.query(
      "SELECT * FROM product_details WHERE batch_number = $1",
      [batch_number]
    );
    if (doesBatchNumberExist.rows.length > 0)
      return res.status(400).json({ message: "Batch Number already exists" });

    const newBatch = await pool.query(
      "INSERT INTO product_details (product_id, batch_number, current_stock, expiry_date) VALUES ($1, $2, $3, $4) RETURNING *",
      [productID.rows[0].product_id, batch_number, current_stock, expiry_date]
    );

    res.status(201).json(newBatch);
  } catch (error) {
    console.log(error);
  }
});

app.post("/api/editstock", async (req, res) => {
  const { batchNumber, dateUsed, quantity } = req.body;

  try {
    const selectedBatch = await pool.query(
      "SELECT * FROM product_details WHERE batch_number = $1",
      [batchNumber]
    );
    if (selectedBatch.rows.length < 0)
      return res.status(400).json({ message: `${batchNumber} does not exist` });

    const { batch_id, product_id, current_stock } = selectedBatch.rows[0];

    const addToUsageLog = await pool.query(
      "INSERT INTO usage_log (batch_id, product_id, date, quantity_used) VALUES ($1, $2, $3, $4) RETURNING *",
      [batch_id, product_id, dateUsed, quantity]
    );

    const newQuantityOfStock = current_stock - quantity;
    console.log("New stock level:", newQuantityOfStock);

    // Double check because maybe the backend or psql number for quanity is saved as a string hence not strictly equal
    if (addToUsageLog.rows[0].quantity_used === quantity) {
      const updateBatchDetails = await pool.query(
        "UPDATE product_details SET current_stock = $1 WHERE batch_id = $2 AND product_id = $3 RETURNING *",
        [newQuantityOfStock, batch_id, product_id]
      );
      res.status(200).json(updateBatchDetails);
    }
  } catch (error) {
    console.log("issue with editing batch endpoint:", error);
  }
});

// This route is for checking expirty/capactiy anf forcasting
app.get("/api/batchdetails", async (req, res) => {
  try {
    const batchDetails = await pool.query(
      "SELECT pi.product_name, pi.strength, pi.reorder_threshold, pi.supplier_lead_time, pd.batch_id, pd.batch_number, pd.current_stock, pd.expiry_date FROM product_details pd JOIN product_inventory pi ON pd.product_id = pi.product_id"
    );
    res.status(200).json(batchDetails.rows);
  } catch (error) {
    res.status(500).json({ error: `${error}` });
  }
});

app.use("/api/ai", aiRoutes);

// app.listen(8080, (req, res) => {
//   console.log("Server is running on PORT 8080");
// });

export default app;

/* BUGS:

* FE has an issue whereby i cat input numbers in decimal places e.g. 12.8 or 0.12 or 0.01 - it only takes whole numbers which is not good

*/
