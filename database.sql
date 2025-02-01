CREATE DATABASE pharmainventory;


CREATE TABLE product_inventory (  -- static product info
    product_id SERIAL PRIMARY KEY,
    product_name VARCHAR(255) NOT NULL,
    strength VARCHAR(255) NOT NULL,
    form VARCHAR(255) NOT NULL,
    reorder_threshold INT NOT NULL,
    supplier_lead_time INT NOT NULL,
    CONSTRAINT unique_product UNIQUE (product_name, strength, form)
);


CREATE TABLE product_details (  -- dynamic product info. for each new product theres new batch number, expiry but the name and stength the same, hence why this table is needed to handle the changing aspects of each product.
    batch_id SERIAL PRIMARY KEY,
    product_id INT NOT NULL,
    batch_number VARCHAR(100) NOT NULL UNIQUE,
    current_stock INT NOT NULL,
    expiry_date DATE NOT NULL,
    CONSTRAINT fk_product
      FOREIGN KEY (product_id)
      REFERENCES product_inventory (product_id)
      ON DELETE CASCADE,
    CONSTRAINT unique_batch_per_product UNIQUE (product_id, batch_number)
);

-- This creates a view to enable us to see the product name along with the product_detials, this is for debugging and clarity. you can query using SELECT * FROM product_details_view;
CREATE VIEW product_details_view AS
SELECT 
  pd.batch_id,
  pi.product_name,
  pi.strength,
  pi.form,
  pd.batch_number,
  pd.current_stock,
  pd.expiry_date
FROM product_details pd
JOIN product_inventory pi 
  ON pd.product_id = pi.product_id;


-- Create the usage_log table to log product usage per batch.
CREATE TABLE usage_log (
    usageLog_id SERIAL PRIMARY KEY,
    batch_id INT NOT NULL,
    product_id INT NOT NULL,
    date DATE NOT NULL,
    quantity_used INT NOT NULL,
    CONSTRAINT fk_usage_product
      FOREIGN KEY (product_id)
      REFERENCES product_inventory (product_id)
      ON DELETE CASCADE,
    CONSTRAINT fk_usage_batch
      FOREIGN KEY (batch_id)
      REFERENCES product_details (batch_id)
      ON DELETE CASCADE
);


-- -- Fetch the product_id for Sertraline 5mg/5ml
--WITH product AS (
  --  SELECT product_id
  --  FROM product_inventory
  --  WHERE product_name = 'Sertraline' AND strength = '5mg/5ml' AND form = 'Bottle'
--)

-- Insert new batch for the existing product

--INSERT INTO product_details (product_id, batch_number, current_stock, expiry_date)
--SELECT product_id, 'BATCH-003', 120, '2025-02-01'
--FROM product;
--What this does: The WITH clause selects the product_id for Sertraline 5mg/5ml.The INSERT INTO product_details statement adds a new batch (BATCH-003) with 120 units in stock and an expiry date of 2025-02-01. The product_id is dynamically fetched from the product_inventory table based on the product name, strength, and form.