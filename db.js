import pkg from "pg";
import dotenv from "dotenv";
const { Pool } = pkg;
import { createClient } from "@supabase/supabase-js";

dotenv.config();

// const supabase = createClient(
//   process.env.SUPABASE_URL,
//   process.env.SUPABASE_KEY
// );

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("supabase.co")
    ? { rejectUnauthorized: false }
    : false,
});
export default pool;
