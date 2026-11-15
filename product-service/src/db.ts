import { Pool } from 'pg';

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  category: string;
  created_at?: string;
}

const defaultProducts: Product[] = [
  {
    id: 'prod-1',
    name: 'UltraBook Pro 15',
    description: 'High-performance laptop for developers with 32GB RAM and 1TB SSD',
    price: 1499.99,
    stock: 25,
    category: 'Computers',
  },
  {
    id: 'prod-2',
    name: 'Studio Sound ANC Headphones',
    description: 'Wireless noise-cancelling over-ear headphones with 40h battery',
    price: 299.99,
    stock: 50,
    category: 'Audio',
  },
  {
    id: 'prod-3',
    name: 'ProTactile Mechanical Keyboard',
    description: 'RGB hot-swappable mechanical keyboard with silent switches',
    price: 149.99,
    stock: 40,
    category: 'Peripherals',
  },
  {
    id: 'prod-4',
    name: 'UltraView 4K IPS Monitor',
    description: '27-inch 4K UHD 144Hz color-accurate designer monitor',
    price: 499.99,
    stock: 15,
    category: 'Displays',
  },
  {
    id: 'prod-5',
    name: 'ThunderDock Pro Hub',
    description: '12-in-1 Thunderbolt 4 docking station with dual 4K video',
    price: 199.99,
    stock: 30,
    category: 'Accessories',
  },
];

let pool: Pool | null = null;
let inMemoryProducts = [...defaultProducts];

export function getDbPool(): Pool | null {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  try {
    pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
    });
    return pool;
  } catch {
    return null;
  }
}

export async function checkDbConnection(): Promise<boolean> {
  const p = getDbPool();
  if (!p) return true; // If no DB configured, in-memory is active and ready
  try {
    const res = await p.query('SELECT 1');
    return res.rowCount === 1;
  } catch {
    return false;
  }
}

export async function getAllProducts(): Promise<Product[]> {
  const p = getDbPool();
  if (p) {
    try {
      const res = await p.query(
        'SELECT id, name, description, price::float, stock, category, created_at FROM products ORDER BY id'
      );
      if (res.rows.length > 0) return res.rows;
    } catch {
      // Fallback to in-memory
    }
  }
  return inMemoryProducts;
}

export async function getProductById(id: string): Promise<Product | null> {
  const p = getDbPool();
  if (p) {
    try {
      const res = await p.query(
        'SELECT id, name, description, price::float, stock, category, created_at FROM products WHERE id = $1',
        [id]
      );
      if (res.rows.length > 0) return res.rows[0];
      return null;
    } catch {
      // Fallback
    }
  }
  const found = inMemoryProducts.find((p) => p.id === id);
  return found || null;
}

export async function reserveProductStock(id: string, quantity: number): Promise<{ success: boolean; remainingStock: number }> {
  const p = getDbPool();
  if (p) {
    try {
      const res = await p.query(
        'UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING stock',
        [quantity, id]
      );
      if (res.rowCount && res.rowCount > 0) {
        return { success: true, remainingStock: res.rows[0].stock };
      }
      return { success: false, remainingStock: 0 };
    } catch {
      // Fallback
    }
  }

  const prod = inMemoryProducts.find((p) => p.id === id);
  if (prod && prod.stock >= quantity) {
    prod.stock -= quantity;
    return { success: true, remainingStock: prod.stock };
  }
  return { success: false, remainingStock: prod ? prod.stock : 0 };
}
