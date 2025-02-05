import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { PromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import pool from "./db.js";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

// routes

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

  console.log(newProduct);
  //   res.status(201).json(newProduct)
});

app.listen(8080, (req, res) => {
  console.log("Server is running on PORT 8080");
});
