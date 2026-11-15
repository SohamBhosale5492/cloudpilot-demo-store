-- Database initialization for cloudpilot-demo-store

CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    stock INTEGER NOT NULL,
    category VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL,
    total_amount NUMERIC(10, 2) NOT NULL,
    items JSONB NOT NULL,
    payment_method VARCHAR(50) NOT NULL,
    payment_reference VARCHAR(100),
    failure_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed realistic demo catalog
INSERT INTO products (id, name, description, price, stock, category) VALUES
('prod-1', 'UltraBook Pro 15', 'High-performance laptop for developers with 32GB RAM and 1TB SSD', 1499.99, 25, 'Computers'),
('prod-2', 'Studio Sound ANC Headphones', 'Wireless noise-cancelling over-ear headphones with 40h battery', 299.99, 50, 'Audio'),
('prod-3', 'ProTactile Mechanical Keyboard', 'RGB hot-swappable mechanical keyboard with silent switches', 149.99, 40, 'Peripherals'),
('prod-4', 'UltraView 4K IPS Monitor', '27-inch 4K UHD 144Hz color-accurate designer monitor', 499.99, 15, 'Displays'),
('prod-5', 'ThunderDock Pro Hub', '12-in-1 Thunderbolt 4 docking station with dual 4K video', 199.99, 30, 'Accessories')
ON CONFLICT (id) DO NOTHING;
