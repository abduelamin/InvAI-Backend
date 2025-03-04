import express from "express";
import pool from "../db.js"; // PostgreSQL connection
import OpenAI from "openai";
import dotenv from "dotenv";
import cron from "node-cron";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function takeSnapshot(type) {
  try {
    const { rows } = await pool.query(`
        SELECT
          pd.*,
          pi.product_name,
          pi.strength,
          pi.form
        FROM product_details pd
        JOIN product_inventory pi ON pd.product_id = pi.product_id
      `);

    await pool.query(
      "INSERT INTO inventory_snapshot (snapshot_type, snapshot_data) VALUES ($1, $2)",
      [type, JSON.stringify(rows)]
    );
    console.log(`Snapshot taken for ${type}`);
  } catch (error) {
    console.error("Snapshot error:", error);
  }
}

// This is for supabase snapshot creation
// async function takeSnapshot(type) {
//   try {
//     const { data: rows, error } = await supabase
//       .from("product_details_view")
//       .select("*");

//     if (error) throw error;

//     const { error: insertError } = await supabase
//       .from("inventory_snapshot")
//       .insert([
//         {
//           snapshot_type: type,
//           snapshot_data: rows,
//         },
//       ]);

//     if (insertError) throw insertError;
//     console.log(`Supabase snapshot taken for ${type}`);
//   } catch (error) {
//     console.error("Supabase snapshot error:", error);
//   }
// }

async function generateWeeklyReport() {
  try {
    const snapshots = await pool.query(`
        SELECT * FROM inventory_snapshot
        WHERE snapshot_type IN ('monday', 'sunday')
        ORDER BY snapshot_date DESC
        LIMIT 2
      `);

    if (snapshots.rows.length < 2) {
      throw new Error("Not enough snapshots available");
    }

    const [sundaySnap, mondaySnap] = snapshots.rows;
    const currentState = sundaySnap.snapshot_data;
    const previousState = mondaySnap.snapshot_data;

    // Get usage data between snapshots
    const usage = await pool.query(
      `SELECT 
          ul.batch_id,
          pd.product_id,
          pi.product_name,
          SUM(ul.quantity_used) AS total_used
        FROM usage_log ul
        JOIN product_details pd ON ul.batch_id = pd.batch_id
        JOIN product_inventory pi ON pd.product_id = pi.product_id
        WHERE ul.date BETWEEN $1 AND $2
        GROUP BY ul.batch_id, pd.product_id, pi.product_name`,
      [mondaySnap.snapshot_date, sundaySnap.snapshot_date]
    );

    // Add the missing inventory comparison logic
    const changes = {
      added: [],
      removed: [],
      stockChanges: [],
    };

    const previousBatches = new Set(previousState.map((b) => b.batch_id));
    const currentBatches = new Set(currentState.map((b) => b.batch_id));

    // Find new batches
    currentState.forEach((batch) => {
      if (!previousBatches.has(batch.batch_id)) {
        changes.added.push({
          product: batch.product_name,
          batch: batch.batch_number,
          added_stock: batch.initial_stock,
        });
      }
    });

    // Find removed batches
    previousState.forEach((batch) => {
      if (!currentBatches.has(batch.batch_id)) {
        changes.removed.push({
          product: batch.product_name,
          batch: batch.batch_number,
          removed_stock: batch.current_stock,
        });
      }
    });

    // Find stock changes
    currentState.forEach((currentBatch) => {
      const previousBatch = previousState.find(
        (b) => b.batch_id === currentBatch.batch_id
      );
      if (previousBatch) {
        const diff = previousBatch.current_stock - currentBatch.current_stock;
        if (diff > 0) {
          changes.stockChanges.push({
            product: currentBatch.product_name,
            batch: currentBatch.batch_number,
            used: diff,
            from_stock: previousBatch.current_stock,
            to_stock: currentBatch.current_stock,
          });
        }
      }
    });

    // create report object
    const report = {
      period: {
        start: mondaySnap.snapshot_date,
        end: sundaySnap.snapshot_date,
      },
      inventory_changes: changes,
      usage_summary: usage.rows,
      expiring_soon: currentState.filter(
        (b) => new Date(b.expiry_date) < new Date(Date.now() + 30 * 86400000)
      ),
    };

    return report;
  } catch (error) {
    console.error("Report generation failed:", error);
    throw error;
  }
}

cron.schedule("0 7 * * 1", () => takeSnapshot("monday"), {
  timezone: "Europe/London",
});
cron.schedule("0 22 * * 0", () => takeSnapshot("sunday"), {
  timezone: "Europe/London",
});

// DONT FORGET TO Add rate limitng
router.get("/forecast", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader(
    "Access-Control-Allow-Origin",
    process.env.NODE_ENV === "production"
      ? "https://inv-ai.vercel.app"
      : "http://localhost:3000"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");

  // heartbeat to prevent connection timeout
  const heartbeat = setInterval(() => {
    res.write(":keep-alive\n\n");
  }, 2000);

  // Handle client disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) {
      res.end();
    }
  });

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
        const estimatedDaysUntilStockout =
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
          estimatedDaysUntilStockout,
          date: usageArray.map((item) => item.date),
        };
      }
    );

    const stream = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are a professional AI inventory forecasting assistant for a pharmaceutical company. Your responses must be written in plain text, without markdown formatting or symbols or asterisks, and should be extremely concise—no more than 300 words. Provide clear, actionable insights based on the provided inventory data. If given dates, analyse these dates and when the items were used to give a general view of increases or decreased in usage",
        },
        {
          role: "user",
          content: `Analyze the following inventory forecast data as of ${new Date().toLocaleDateString()} and provide a concise narrative explanation in plain text (no markdown formatting, symbols, or asterisks) of 300 words or less. Your response must be organized into three clearly labeled sections, each starting on a new line with a heading in all caps followed by a colon. The sections are:
          
          KEY OBSERVATIONS:
          Summarize the main trends and issues in the data, explicitly referencing today's date. Focus on daily usage trends and their impact on inventory levels, and mention any abnormal usage spikes or anomalies.
          
          PREDICTIVE OUTLOOK:
          Begin with the phrase 'Given the current usage activity:' Then, for each product, list with this format:
          - [Batch Number] [Product Name] ([Strength]): [Estimated stockout days] days until stockout (predicted date: [Calculated date]).  
          If a product has a negative or zero current stock, clearly state that a stockout has already occurred.
          
          ACTIONABLE RECOMMENDATIONS:
          Provide specific and valuable/informative actionable inventory recommendations. Indicate which products require immediate restocking.
          
          For each product mentioned, always reference the batch number, product name, and strength to distinguish them.
          Data: ${JSON.stringify(forecastResults)}`,
        },
      ],
      stream: true,
      model: "gpt-4o-mini",
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0].delta?.content;
      if (token) {
        res.write(`data: ${token}\n\n`);
        if (res.flush) res.flush();
      }
    }

    // Cleanup
    clearInterval(heartbeat);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("Error:", error.message);
    clearInterval(heartbeat);
    res.write(`data: [ERROR] ${error.message}\n\n`);
    res.end();
  }
});

// Weekly report endpoint - testing purposes only to ensure im getting the correct data.
router.get("/report", async (req, res) => {
  try {
    const report = await generateWeeklyReport();
    res.json(report);
  } catch (error) {
    console.error("Report error:", error);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 4,
  message: {
    error: "Too many requests to AI, please try again after 10 minutes",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/weekly-report", limiter, async (req, res) => {
  try {
    const report = await generateWeeklyReport();
    const prompt = `
Act as a senior pharmaceutical inventory analyst. Using the JSON data provided below, generate an executive weekly report that is both extremely concise and thoroughly analytical. Your output must be in plain text with no markdown formatting, symbols, or asterisks. Do not reveal raw JSON data.

Your report must include the following sections:

Executive Summary (maximum 3 sentences):

Summarize overall inventory health using key metrics, including stock turnover rate, days of inventory remaining, and expiry risk.
Flag any critical issues requiring immediate attention (e.g., batches with less than 20 days of stock or significant usage variance).
Identify the top-performing and underperforming products, noting any compliance concerns (GMP or FIFO).
Detailed Key Metrics (numeric comparisons):

Calculate and present the stock turnover rate using: (Total Used / Average Stock × 100) and show the computed value in parentheses (include units, if applicable).
Compute days of inventory remaining using: (Current Stock / Avg Daily Usage) with exact numbers and units.
Present the expiry risk index as: (Qty Expiring Soon / Total Stock × 100) in percentage form with the computed figure.
Calculate the reorder urgency score as: (Current Stock / Reorder Threshold × 100) and display the exact percentage.
Include the formulas and actual computed numbers with proper units.
Inventory Analysis:

Create a batch performance table with the columns: Batch, Product, Initial Stock, Current Stock, Used (%) (calculated as ((Initial – Current)/Initial × 100)), and Days Remaining.
Sort the table by usage percentage (highest first).
Highlight any batch where the current stock is less than (reorder threshold plus lead time demand), usage variance exceeds 15% from the product average, or the expiry is within the supplier lead time window.
Use pharmaceutical terms such as “batch,” “formulation,” and “cold chain.”
Mark critical values (e.g., stock remaining for less than 20 days) with the indicator (■ RED ■) and use text-only color indicators (■ RED ■, ■ AMBER ■, ■ GREEN ■).
Trend Insights:

Analyze weekly usage trends using text-based notations (for example, “+25%” or “-10%”) and compare current usage rates with the previous period.
Identify and briefly describe any seasonal patterns or anomalies in the data.
Risk Assessment:

Calculate potential stockout dates using: Stockout Date = Today + (Current Stock / 7-day average usage) and include the computed date.
Quantify the financial impact of expiring batches using: At-Risk Value = Expiring Quantity × Average Unit Cost, with the computed amount.
Actionable Recommendations:

Provide a clear, prioritized action plan, including a priority matrix (Urgent/Important).
Outline a restock plan with exact batch identifiers, recommended order quantities (using EOQ = √((2×Annual Usage×Order Cost)/Holding Cost) with the computed value), and last order dates.
Suggest expiry mitigation strategies (such as discounting, transferring, or returning stock).
Highlight any detected compliance issues (such as GMP or FIFO violations).
Formatting Rules:

Do not include any markdown formatting, symbols, or asterisks.
Output must be plain text only.
All numbers must be shown in parentheses.
Do not include raw JSON structures.
Ensure the report is data-driven, in-depth, and provides actionable insights for strategic planning.
Data: ${JSON.stringify(report, null, 2)}
`;

    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    res.json({
      raw_data: report,
      summary: gptResponse.choices[0].message.content,
    });
  } catch (error) {
    res.status(500).json({ error: "Report generation failed" });
  }
});

// Data simulation to ensure each endpoint works correctly.
// router.post("/simulate-2025-data", async (req, res) => {
//   try {
//     // Clear existing data
//     await pool.query("DELETE FROM usage_log");
//     await pool.query("DELETE FROM inventory_snapshot");
//     await pool.query("DELETE FROM product_details");
//     await pool.query("DELETE FROM product_inventory");

//     // Create 6 core pharmaceutical products
//     const products = await pool.query(`
//         INSERT INTO product_inventory
//           (product_name, strength, form, reorder_threshold, supplier_lead_time)
//         VALUES
//           ('Paracetamol', '500mg', 'Tablet', 200, 14),
//           ('Ibuprofen', '200mg', 'Tablet', 300, 21),
//           ('Omeprazole', '20mg', 'Capsule', 150, 28),
//           ('Amoxicillin', '500mg', 'Capsule', 250, 35),
//           ('Cetirizine', '10mg', 'Tablet', 180, 14),
//           ('Loratadine', '10mg', 'Tablet', 200, 14)
//         RETURNING product_id, product_name
//       `);

//     // Create batches with Feb 2025 base date
//     const baseDate = new Date("2025-02-01");
//     const batchData = products.rows.flatMap((product) => {
//       return [
//         {
//           product_id: product.product_id,
//           batch_number: `BATCH-${product.product_id}-FEB25`,
//           initial_stock: 1500,
//           expiry_date: new Date("2026-02-01"),
//           usage_pattern: {
//             min: 20, // daily min usage
//             max: 40, // daily max usage
//           },
//         },
//         {
//           product_id: product.product_id,
//           batch_number: `BATCH-${product.product_id}-MAR25`,
//           initial_stock: 1500,
//           expiry_date: new Date("2026-03-01"),
//           usage_pattern: {
//             min: 15,
//             max: 30,
//           },
//         },
//       ];
//     });

//     // Insert batches with stock protection
//     const batches = await Promise.all(
//       batchData.map(async (batch) => {
//         const result = await pool.query(
//           `INSERT INTO product_details
//             (product_id, batch_number, current_stock, initial_stock, expiry_date)
//            VALUES ($1, $2, $3, $4, $5)
//            RETURNING batch_id`,
//           [
//             batch.product_id,
//             batch.batch_number,
//             batch.initial_stock,
//             batch.initial_stock,
//             batch.expiry_date,
//           ]
//         );
//         return { ...batch, batch_id: result.rows[0].batch_id };
//       })
//     );

//     // Generate 8 weeks of varied usage (Feb 1 - Mar 31 2025)
//     const startDate = new Date("2025-02-01");
//     const endDate = new Date("2025-04-01");

//     for (
//       let date = new Date(startDate);
//       date < endDate;
//       date.setDate(date.getDate() + 1)
//     ) {
//       // Skip weekends for realistic pharmacy patterns
//       if (date.getDay() % 6 === 0) continue; // Skip Sat/Sun

//       await Promise.all(
//         batches.map(async (batch) => {
//           const dailyUsage =
//             Math.floor(
//               Math.random() *
//                 (batch.usage_pattern.max - batch.usage_pattern.min + 1)
//             ) + batch.usage_pattern.min;

//           // Get current stock before update
//           const currentStock = await pool.query(
//             "SELECT current_stock FROM product_details WHERE batch_id = $1",
//             [batch.batch_id]
//           );

//           const usableQty = Math.min(
//             dailyUsage,
//             currentStock.rows[0].current_stock
//           );

//           if (usableQty > 0) {
//             await pool.query(
//               `INSERT INTO usage_log
//                 (batch_id, product_id, date, quantity_used)
//                VALUES ($1, $2, $3, $4)`,
//               [batch.batch_id, batch.product_id, new Date(date), usableQty]
//             );

//             await pool.query(
//               `UPDATE product_details
//                SET current_stock = GREATEST(0, current_stock - $1)
//                WHERE batch_id = $2`,
//               [usableQty, batch.batch_id]
//             );
//           }
//         })
//       );
//     }

//     // Create weekly snapshots (Every Monday 7am and Sunday 10pm)
//     let snapshotDate = new Date("2025-02-03"); // First Monday in Feb
//     while (snapshotDate < endDate) {
//       // Monday snapshot
//       await takeSnapshot("monday");

//       // Sunday snapshot
//       const sundayDate = new Date(snapshotDate);
//       sundayDate.setDate(snapshotDate.getDate() + 6);
//       sundayDate.setHours(22, 0, 0);
//       await takeSnapshot("sunday");

//       snapshotDate.setDate(snapshotDate.getDate() + 7);
//     }

//     res.json({
//       message: "2025 Q1 Simulation Complete",
//       stats: {
//         products: products.rows.length,
//         batches: batches.length,
//         usage_days: 8 * 5 * 4, // 8 weeks × 5 days/week × 4 weeks/month
//         total_usage: batches.reduce(
//           (sum, b) => sum + (1500 - b.initial_stock),
//           0
//         ),
//       },
//       note: "Varied usage patterns: Paracetamol (20-40/day), Ibuprofen (15-30/day), etc.",
//     });
//   } catch (error) {
//     console.error("Simulation error:", error);
//     res.status(500).json({
//       error: "Simulation failed",
//       details: error.message,
//     });
//   }
// });

// subabase simulaton:

// router.post("/simulate-2025-data", async (req, res) => {
//   try {
//     // Clear existing data
//     await supabase.from("usage_log").delete();
//     await supabase.from("inventory_snapshot").delete();
//     await supabase.from("product_details").delete();
//     await supabase.from("product_inventory").delete();

//     // Create pharmaceutical products
//     const { data: products, error: productError } = await supabase
//       .from("product_inventory")
//       .upsert(
//         [
//           {
//             product_name: "Paracetamol",
//             strength: "500mg",
//             form: "Tablet",
//             reorder_threshold: 150,
//             supplier_lead_time: 14,
//           },
//           {
//             product_name: "Ibuprofen",
//             strength: "200mg",
//             form: "Tablet",
//             reorder_threshold: 200,
//             supplier_lead_time: 21,
//           },
//           {
//             product_name: "Omeprazole",
//             strength: "20mg",
//             form: "Capsule",
//             reorder_threshold: 100,
//             supplier_lead_time: 28,
//           },
//           {
//             product_name: "Amoxicillin", // Target for stockout
//             strength: "500mg",
//             form: "Capsule",
//             reorder_threshold: 180,
//             supplier_lead_time: 35,
//           },
//           {
//             product_name: "Cetirizine",
//             strength: "10mg",
//             form: "Tablet",
//             reorder_threshold: 120,
//             supplier_lead_time: 14,
//           },
//           {
//             product_name: "Loratadine",
//             strength: "10mg",
//             form: "Tablet",
//             reorder_threshold: 150,
//             supplier_lead_time: 14,
//           },
//           {
//             product_name: "Aspirin",
//             strength: "81mg",
//             form: "Tablet",
//             reorder_threshold: 250,
//             supplier_lead_time: 10,
//           },
//         ],
//         { onConflict: ["product_name", "strength", "form"] }
//       )
//       .select();

//     if (productError) throw new Error("Product error: " + productError.message);

//     // Create batches with customized stock levels and usage patterns
//     const batchData = products
//       .map((product) => {
//         // Configure stockout candidate (Amoxicillin)
//         let baseStock, usagePattern;

//         if (product.product_name === "Amoxicillin") {
//           baseStock = 800; // Low initial stock
//           usagePattern = { min: 25, max: 40 }; // High usage
//         } else if (product.product_name === "Aspirin") {
//           baseStock = 3000;
//           usagePattern = { min: 8, max: 12 };
//         } else {
//           baseStock = 2500; // Higher stock for others
//           usagePattern = { min: 2, max: 5 }; // Low usage
//         }

//         return [
//           {
//             product_id: product.product_id,
//             batch_number: `BATCH-${product.product_id}-SPRING25`,
//             initial_stock: baseStock,
//             current_stock: baseStock,
//             expiry_date: new Date("2025-05-15"),
//             usage_pattern: usagePattern,
//           },
//           {
//             product_id: product.product_id,
//             batch_number: `BATCH-${product.product_id}-SUMMER25`,
//             initial_stock: baseStock,
//             current_stock: baseStock,
//             expiry_date: new Date("2025-07-31"),
//             usage_pattern: usagePattern,
//           },
//         ];
//       })
//       .flat();

//     // Insert batches
//     const batchInsertData = batchData.map(({ usage_pattern, ...rest }) => rest);
//     const { data: batches, error: batchError } = await supabase
//       .from("product_details")
//       .upsert(batchInsertData, { onConflict: ["batch_number"] })
//       .select();

//     if (batchError) throw new Error("Batch error: " + batchError.message);

//     // Attach usage patterns
//     const batchesWithUsage = batches.map((dbBatch) => ({
//       ...dbBatch,
//       usage_pattern: batchData.find(
//         (b) => b.batch_number === dbBatch.batch_number
//       ).usage_pattern,
//     }));

//     // Generate usage data
//     const startDate = new Date("2025-02-22");
//     const endDate = new Date("2025-07-31");
//     let currentDate = new Date(startDate);

//     while (currentDate <= endDate) {
//       if (currentDate.getDay() !== 0 && currentDate.getDay() !== 6) {
//         await Promise.all(
//           batchesWithUsage.map(async (batch) => {
//             const dailyUsage = Math.floor(
//               Math.random() *
//                 (batch.usage_pattern.max - batch.usage_pattern.min) +
//                 batch.usage_pattern.min
//             );

//             const { data: productDetails } = await supabase
//               .from("product_details")
//               .select("current_stock")
//               .eq("batch_id", batch.batch_id)
//               .single();

//             const currentStock = productDetails?.current_stock || 0;

//             if (currentStock > 0) {
//               const used = Math.min(dailyUsage, currentStock);

//               await supabase.from("usage_log").insert([
//                 {
//                   batch_id: batch.batch_id,
//                   product_id: batch.product_id,
//                   date: currentDate,
//                   quantity_used: used,
//                 },
//               ]);

//               await supabase
//                 .from("product_details")
//                 .update({ current_stock: Math.max(0, currentStock - used) })
//                 .eq("batch_id", batch.batch_id);
//             }
//           })
//         );
//       }
//       currentDate.setDate(currentDate.getDate() + 1);
//     }

//     // Create bi-weekly snapshots
//     let snapshotDate = new Date("2025-02-23"); // last Monday in Feb
//     while (snapshotDate < endDate) {
//       // Monday snapshot
//       await takeSnapshot("monday");

//       // Sunday snapshot
//       const sundayDate = new Date(snapshotDate);
//       sundayDate.setDate(snapshotDate.getDate() + 6);
//       sundayDate.setHours(22, 0, 0);
//       await takeSnapshot("sunday");

//       snapshotDate.setDate(snapshotDate.getDate() + 7);
//     }

//     res.json({
//       message: "2025 Simulation Complete",
//       stats: {
//         products: products.length,
//         batches: batchesWithUsage.length,
//         usage_days: Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)),
//         total_usage: batchesWithUsage.reduce(
//           (sum, b) => sum + (b.initial_stock - b.current_stock),
//           0
//         ),
//       },
//       note: "Realistic demo: 1 product out of stock, others maintain inventory",
//     });
//   } catch (error) {
//     console.error("Simulation error:", error);
//     res.status(500).json({
//       error: "Simulation failed",
//       details: error.message,
//     });
//   }
// });
export default router;
