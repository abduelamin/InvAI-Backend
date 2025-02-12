import express from "express";
import pool from "../db.js"; // PostgreSQL connection
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.get("/forecast", async (req, res) => {
  try {
    // Fetch stock data
    const stockData = await pool.query(`
      SELECT pd.batch_id, pi.product_name, pd.batch_number, pi.form, pd.current_stock, pi.supplier_lead_time, 
        COALESCE(AVG(ul.quantity_used), 0) AS avg_daily_usage
      FROM product_details pd
      JOIN product_inventory pi ON pd.product_id = pi.product_id
      LEFT JOIN usage_log ul ON pd.batch_id = ul.batch_id
      GROUP BY pd.batch_id, pi.product_name, pi.form, pd.current_stock, pi.supplier_lead_time
    `);

    // Process Data & Prepare for AI Forecasting
    let forecasts = stockData.rows.map((row) => {
      const estimatedDaysLeft = row.current_stock / (row.avg_daily_usage || 1);
      return {
        product: row.product_name,
        batchNumber: row.batch_number,
        form: row.form,
        stock: row.current_stock,
        estimatedDaysLeft: Math.round(estimatedDaysLeft),
        reorderRecommendation:
          estimatedDaysLeft <= row.supplier_lead_time
            ? "Reorder Soon"
            : "Sufficient Stock",
      };
    });

    // const response = await openai.chat.completions.create({
    //   messages: [
    //     {
    //       role: "system",
    //       content:
    //         "You are an AI assistant that generates inventory forecasting insights.",
    //     },
    //     {
    //       role: "user",
    //       content: `Analyze this stock data: ${JSON.stringify(forecasts)}`,
    //     },
    //   ],
    //   model: "gpt-4",
    // });

    res.json({
      forecasts,
      //   aiSummary: response.choices[0].message.content,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server Error" });
  }
});

export default router;
