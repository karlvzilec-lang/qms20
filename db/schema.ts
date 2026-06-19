import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

// Shared application data store.
// The QAMS frontend organizes all of its state into named "buckets"
// (users, evaluations, surveys, settings, etc.). Each bucket holds one
// JSON document. This table is the durable, shared copy of those buckets
// so that every user sees and updates the same live data.
export const qamsData = pgTable("qams_data", {
  bucket: text().primaryKey(),
  data: jsonb(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
