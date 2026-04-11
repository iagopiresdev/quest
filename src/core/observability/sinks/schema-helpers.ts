import { z } from "zod";

export const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);
export const urlSchema = z.url().max(400);
export const secretRefSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
