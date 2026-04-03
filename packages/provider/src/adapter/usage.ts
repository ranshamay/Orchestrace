export function mergeUsage(
  target: { input: number; output: number; cost: number },
  incoming: { input: number; output: number; cost: number },
): void {
  target.input += incoming.input;
  target.output += incoming.output;
  target.cost += incoming.cost;
}