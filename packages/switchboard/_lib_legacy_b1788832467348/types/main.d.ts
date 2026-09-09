#!/usr/bin/env node
import { type CoordinatorConfig } from './coordinator.js';
declare function boot(config: CoordinatorConfig): void;
export { boot };
