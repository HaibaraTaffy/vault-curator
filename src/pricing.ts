/** DeepSeek 最新价格(元/百万 tokens)
 *  空闲时段:flash 输入 1.5 / 输出 4.5;pro 输入 4.5 / 输出 13.5
 *  高峰时段约为空闲时段 2 倍(flash 3.0/9.0,pro 9.0/27.0)
 *  缓存命中输入更便宜(flash 0.05,pro 0.15),此处按缓存未命中做保守估算 */
export function pricePerM(model: string): { input: number; output: number } {
  if (model.includes("pro")) return { input: 4.5, output: 13.5 };
  return { input: 1.5, output: 4.5 }; // flash / chat 等默认
}

export function costTextFor(prompt: number, completion: number, model: string): string {
  const p = pricePerM(model);
  const cny = (prompt / 1e6) * p.input + (completion / 1e6) * p.output;
  return "≈¥" + (cny >= 0.01 ? cny.toFixed(2) : cny.toFixed(4));
}
