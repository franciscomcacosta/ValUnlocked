// Discord bot entrypoint.
// Auto-loads every command module in bot/commands/*.ts so adding a new
// command is just dropping a file in there. Each command file exports:
//   export const data = new SlashCommandBuilder()...
//   export async function execute(interaction) {...}
//
// Run with: npm run bot
import { Client, GatewayIntentBits, Events, Collection, type ChatInputCommandInteraction, type ButtonInteraction } from "discord.js";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface CommandModule {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  handleButton?(interaction: ButtonInteraction): Promise<void>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, "commands");

const commands = new Collection<string, CommandModule>();

async function loadCommands() {
  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(commandsDir, file)).href)) as CommandModule;
    if (!mod.data || !mod.execute) {
      console.warn(`[bot] ${file} has no data/execute export, skipping`);
      continue;
    }
    commands.set(mod.data.name, mod);
    console.log(`[bot] loaded /${mod.data.name}`);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => console.log(`[bot] ready as ${c.user.tag}`));

client.on(Events.InteractionCreate, async (interaction) => {
  // Slash command dispatch.
  if (interaction.isChatInputCommand()) {
    const cmd = commands.get(interaction.commandName);
    if (!cmd) {
      await interaction.reply({ content: "Unknown command — try again?", ephemeral: true });
      return;
    }
    try {
      await cmd.execute(interaction);
    } catch (e) {
      console.error(`[bot] /${interaction.commandName} failed`, e);
      const content = "Something broke running that. Try again or ping staff.";
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true });
      else await interaction.reply({ content, ephemeral: true });
    }
    return;
  }

  // Button dispatch — the button customId format is "<command>:<arg>" so
  // we can route it to the same command module's handleButton.
  if (interaction.isButton()) {
    const [commandName] = interaction.customId.split(":");
    const cmd = commands.get(commandName);
    if (!cmd?.handleButton) return;
    try {
      await cmd.handleButton(interaction);
    } catch (e) {
      console.error(`[bot] button ${interaction.customId} failed`, e);
      const content = "Something broke. Try again.";
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ephemeral: true });
      else await interaction.reply({ content, ephemeral: true });
    }
  }
});

loadCommands().then(() => client.login(process.env.DISCORD_BOT_TOKEN));
