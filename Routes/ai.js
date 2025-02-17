import express from "express";
import pool from "../db.js"; // PostgreSQL connection
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();
const router = express.Router();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Add rate limitng
router.get("/forecast", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:3000");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  try {
    const usageData = await pool.query(
      "SELECT ul.usageLog_id, ul.batch_id, ul.product_id, ul.date, ul.quantity_used, pd.batch_number, pd.current_stock,  pd.expiry_date, pd.initial_stock, pi.product_name, pi.strength, pi.reorder_threshold, pi.supplier_lead_time FROM usage_log ul JOIN product_details pd ON ul.batch_id = pd.batch_id  JOIN product_inventory pi ON ul.product_id = pi.product_id"
    );

    const batchUsageData = usageData.rows;

    const groupedByBatch = batchUsageData.reduce((acc, batchDetails) => {
      const key = batchDetails.batch_id;
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push({
        quantityUsed: batchDetails.quantity_used,
        date: batchDetails.date,
        batchNumber: batchDetails.batch_number,
        productName: batchDetails.product_name,
        strength: batchDetails.strength,
        reorderThreshold: batchDetails.reorder_threshold,
        supplierleadTime: batchDetails.supplier_lead_time,
        currentStock: batchDetails.current_stock,
        initialStock: batchDetails.initial_stock,
      });
      return acc;
    }, {});

    const exponentialSmoothing = (dataPoints, alpha) => {
      let s = dataPoints[0].quantityUsed;
      for (let i = 1; i < dataPoints.length; i++) {
        s = alpha * dataPoints[i].quantityUsed + (1 - alpha) * s;
      }
      return s;
    };

    const forecastResults = Object.entries(groupedByBatch).map(
      ([batchId, usageArray]) => {
        const forecastValue = exponentialSmoothing(usageArray, 0.4);
        const estimatedStockoutDays =
          forecastValue > 0 ? usageArray[0].currentStock / forecastValue : null;
        return {
          batchId,
          forecast: forecastValue,
          name: usageArray[0].productName,
          strength: usageArray[0].strength,
          batchNumber: usageArray[0].batchNumber,
          reorderThreshold: usageArray[0].reorderThreshold,
          supplierLeadTime: usageArray[0].supplierleadTime,
          initialStock: usageArray[0].initialStock,
          currentStock: usageArray[0].currentStock,
          quantityUsed: usageArray
            .map((item) => item.quantityUsed)
            .reduce((acc, curr) => acc + curr),
          estimatedStockoutDays,
          date: usageArray.map((item) => item.date),
        };
      }
    );

    const stream = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are a professional AI inventory forecasting assistant for a pharmaceutical company. Your responses must be written in plain text, without markdown formatting or symbols, and should be extremely concise—no more than 180 words or 6 sentences. Provide clear, actionable insights based on the provided inventory data.",
        },
        {
          role: "user",
          content: `Please analyze the following inventory forecast data and provide a brief narrative explanation that includes key observations, a predictive outlook on when products might stock out (using the estimatedStockoutDays field), and actionable recommendations for inventory management. Limit your response to 180 words or less. When referring to products, reference the batch number, product name, and strength to distinguish them: ${JSON.stringify(
            forecastResults
          )}`,
        },
      ],
      stream: true,
      model: "gpt-4o-mini",
    });

    // Stream response
    for await (const chunk of stream) {
      const token = chunk.choices[0].delta?.content;
      if (token) {
        res.write(`data: ${token}\n\n`);
        if (res.flush) res.flush();
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("Error:", error.message);
    res.write(`data: Error: ${error.message}\n\n`);
    res.end();
  }
});

export default router;
