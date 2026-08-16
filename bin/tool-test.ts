import plugin from "../dist/plugin.js";

const toolName = process.argv[2] ?? "browser_status";
const rawArgs = process.argv[3];

let args: Record<string, string | number | boolean | null> = {};
if (rawArgs) {
  try {
    args = JSON.parse(rawArgs);
  } catch (error) {
    console.error("Args must be valid JSON.");
    console.error(String(error));
    process.exit(1);
  }
}

try {
  const tools = new Map();
  await plugin.setup({
    tool: {
      transform: async (cb) => {
        await cb({
          add: (t) => tools.set(t.name, t),
        });
      },
    },
  });

  const tool = tools.get(toolName);
  if (!tool) {
    console.error(`Tool not found: ${toolName}`);
    process.exit(1);
  }

  const result = await tool.execute(args, {});
  if (result instanceof Object) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(String(result));
  }
  process.exit(0);
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
