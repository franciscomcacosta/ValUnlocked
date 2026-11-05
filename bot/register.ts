// Auto-discovers every command module in bot/commands/*.ts and registers
// their slash commands with Discord. Run after adding or changing a command:
//   npm run bot:register
// Guild registration (DISCORD_GUILD_ID set) is instant; global can take ~1h.
import { REST, Routes } from "discord.js";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, "commands");

interface CommandModule {
  data: { name: string; toJSON(): unknown };
}

async function main() {
  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  const commands: unknown[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(commandsDir, file)).href)) as CommandModule;
    if (!mod.data) {
      console.warn(`[register] ${file} has no data export, skipping`);
      continue;
    }
    commands.push(mod.data.toJSON());
    console.log(`[register] /${mod.data.name}`);
  }

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN!);
  const appId = process.env.DISCORD_CLIENT_ID!;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
    console.log(`[register] ✅ ${commands.length} guild commands registered (instant).`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log(`[register] ✅ ${commands.length} global commands registered (may take ~1h to propagate).`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
