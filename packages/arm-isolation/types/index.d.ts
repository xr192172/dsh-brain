/**
 * arm-isolation — 臂间隔离层（只禁止互读互写）
 */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
export declare const name = "arm-isolation";
export declare const inject: string[];
export declare function isDenied(pathOrArgs: unknown, denyRoots: string[]): boolean;
export declare const Config: z.ZodPreprocess<z.ZodObject<{
    self: z.ZodOptional<z.ZodString>;
    arms: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    extraDeny: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>, unknown>;
export declare function apply(ctx: Context, config: z.infer<typeof Config>): void;
