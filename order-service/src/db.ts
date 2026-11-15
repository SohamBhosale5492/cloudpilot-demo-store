import { Pool } from 'pg';

export interface OrderItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderRecord {
  id: string;
  customer_id: string;
  status: 'PENDING' | 'CONFIRMED' | 'PAYMENT_FAILED' | 'CANCELLED';
  total_amount: number;
  items: OrderItem[];
  payment_method: string;
  payment_reference?: string | null;
  failure_reason?: string | null;
  created_at?: string;
}

let pool: Pool | null = null;
const inMemoryOrders: OrderRecord[] = [];

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
  if (!p) return true;
  try {
    const res = await p.query('SELECT 1');
    return res.rowCount === 1;
  } catch {
    return false;
  }
}

export async function saveOrder(order: OrderRecord): Promise<OrderRecord> {
  const p = getDbPool();
  const createdAt = new Date().toISOString();
  const fullOrder = { ...order, created_at: createdAt };

  if (p) {
    try {
      await p.query(
        `INSERT INTO orders (id, customer_id, status, total_amount, items, payment_method, payment_reference, failure_reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          fullOrder.id,
          fullOrder.customer_id,
          fullOrder.status,
          fullOrder.total_amount,
          JSON.stringify(fullOrder.items),
          fullOrder.payment_method,
          fullOrder.payment_reference || null,
          fullOrder.failure_reason || null,
          createdAt,
        ]
      );
      return fullOrder;
    } catch {
      // Fallback to in-memory
    }
  }

  inMemoryOrders.unshift(fullOrder);
  return fullOrder;
}

export async function getOrderById(id: string): Promise<OrderRecord | null> {
  const p = getDbPool();
  if (p) {
    try {
      const res = await p.query(
        `SELECT id, customer_id, status, total_amount::float, items, payment_method, payment_reference, failure_reason, created_at
         FROM orders WHERE id = $1`,
        [id]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          ...row,
          items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items,
        };
      }
      return null;
    } catch {
      // Fallback
    }
  }

  const found = inMemoryOrders.find((o) => o.id === id);
  return found || null;
}

export async function getAllOrders(): Promise<OrderRecord[]> {
  const p = getDbPool();
  if (p) {
    try {
      const res = await p.query(
        `SELECT id, customer_id, status, total_amount::float, items, payment_method, payment_reference, failure_reason, created_at
         FROM orders ORDER BY created_at DESC LIMIT 50`
      );
      return res.rows.map((row) => ({
        ...row,
        items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items,
      }));
    } catch {
      // Fallback
    }
  }

  return inMemoryOrders;
}
