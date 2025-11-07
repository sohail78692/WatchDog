// --- CONFIGURATION SETUP ---
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express'); // 1. Import Express
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    PermissionsBitField,
    AuditLogEvent,
    Collection,
    Colors
} = require('discord.js');

// Access variables from .env
const BOT_TOKEN = process.env.BOT_TOKEN;
const PREFIX = '!';
// Use process.env.PORT or default to 3000 for the web server
const PORT = process.env.PORT || 3000; 
const CONFIG_FILE = 'config.json';
// New file for storing persistent nickname data
const NICKNAME_HISTORY_FILE = 'nicknameHistory.json'; 
const LOGO_URL = 'https://placehold.co/128x128/3498db/ffffff?text=WD'; 

if (!BOT_TOKEN) {
    console.error("❌ ERROR: BOT_TOKEN is missing in the .env file.");
    process.exit(1);
}

// Initialize Client with ALL necessary intents, including Emoji/Sticker
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildEmojisAndStickers, 
    ],
});

// Global Caches
let guildConfig = {}; // Guild ID -> Log Channel ID
let nicknameHistory = {}; // Guild ID -> { User ID -> [nicknames] }
client.commands = new Collection();
client.invites = new Collection();

// ===================================
// === CONFIGURATION AND UTILITIES ===
// ===================================

/**
 * Loads configuration files (log channel IDs and nickname history).
 */
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            guildConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            console.log(`✅ Loaded log configuration for ${Object.keys(guildConfig).length} guild(s).`);
        } else {
            console.log("⚠️ Config file not found, starting with empty log configuration.");
        }
        
        if (fs.existsSync(NICKNAME_HISTORY_FILE)) {
            nicknameHistory = JSON.parse(fs.readFileSync(NICKNAME_HISTORY_FILE, 'utf8'));
            console.log(`✅ Loaded nickname history.`);
        } else {
            console.log("⚠️ Nickname history file not found, starting empty history.");
        }
    } catch (e) {
        console.error(`❌ Error loading config files: ${e.message}`);
        guildConfig = {};
        nicknameHistory = {};
    }
}

/**
 * Saves the current log channel configuration and nickname history.
 */
function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(guildConfig, null, 2), 'utf8');
        fs.writeFileSync(NICKNAME_HISTORY_FILE, JSON.stringify(nicknameHistory, null, 2), 'utf8');
    } catch (e) {
        console.error(`❌ Error saving config files: ${e.message}`);
    }
}

/**
 * Adds a nickname change to the persistent history.
 * @param {Guild} guild The guild object.
 * @param {GuildMember} member The member object.
 * @param {string} nickname The new nickname to record.
 */
function recordNickname(guild, member, nickname) {
    if (!guild || !member || !nickname) return;
    const userId = member.id;
    const guildId = guild.id;

    if (!nicknameHistory[guildId]) {
        nicknameHistory[guildId] = {};
    }
    if (!nicknameHistory[guildId][userId]) {
        nicknameHistory[guildId][userId] = [];
    }
    
    // Only store unique, non-empty nicknames
    if (nickname && !nicknameHistory[guildId][userId].includes(nickname)) {
        // Keep history manageable (e.g., last 20 nicknames)
        nicknameHistory[guildId][userId].unshift(nickname); 
        nicknameHistory[guildId][userId] = nicknameHistory[guildId][userId].slice(0, 20);
        saveConfig();
    }
}

/**
 * Retrieves the nickname history for a user.
 * @param {string} guildId The guild ID.
 * @param {string} userId The user ID.
 * @returns {string} Formatted list of past nicknames.
 */
function getNicknameHistory(guildId, userId) {
    const history = nicknameHistory[guildId]?.[userId] || [];
    if (history.length === 0) return 'None recorded.';
    // Display all but the current nickname (which is logged in the main event)
    return history.slice(1).join(', '); 
}

/**
 * Main function to send log embeds to the configured channel.
 * @param {Guild} guild The guild object.
 * @param {string} title The title of the embed.
 * @param {string} description The main content of the embed.
 * @param {number} color The color code for the embed (e.g., Colors.Green).
 * @param {User|GuildMember|null} [user=null] The user object to set as the embed author/thumbnail.
 * @returns {Promise<void>}
 */
async function logEvent(guild, title, description, color, user = null) {
    const channelId = guildConfig[guild.id];
    if (!channelId) return;

    try {
        const channel = await guild.channels.fetch(channelId);
        if (!channel || channel.type !== 0) return;

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setTimestamp()
            .setFooter({ text: `WatchDog | Guild ID: ${guild.id}` });

        if (user) {
            const targetUser = user.user || user;
            const avatarURL = targetUser.displayAvatarURL({ dynamic: true });

            embed.setAuthor({ name: `${targetUser.tag} (${targetUser.id})`, iconURL: avatarURL });
            embed.setThumbnail(avatarURL);
        } else {
            embed.setAuthor({ name: 'WatchDog System', iconURL: LOGO_URL });
        }

        await channel.send({ embeds: [embed] });
    } catch (e) {
        console.error(`❌ Could not log event in guild ${guild.name} (ID: ${guild.id}, Channel: ${channelId}): ${e.message}`);
        if (e.code === 10003 || e.code === 50001) {
            delete guildConfig[guild.id];
            saveConfig();
        }
    }
}

/**
 * Tries to fetch the responsible user from the Audit Log for a given event type.
 * @param {Guild} guild The guild object.
 * @param {AuditLogEvent|AuditLogEvent[]} type The audit log event type(s).
 * @param {string} [targetId=null] The ID of the affected entity (optional for general events).
 * @returns {Promise<{executor: User|null, reason: string|null}>} The user who performed the action and the reason.
 */
async function getAuditLogExecutor(guild, type, targetId = null) {
    try {
        // Ensure type is an array for consistent handling
        const types = Array.isArray(type) ? type : [type]; 

        const fetchedLogs = await guild.fetchAuditLogs({
            limit: 5, // Fetch a few logs to ensure we don't miss recent events
            type: types,
        });

        const auditEntry = fetchedLogs.entries.find(
            // Target ID must match if provided, and the action must have happened very recently
            a => types.includes(a.action) && (!targetId || a.targetId === targetId) && Date.now() - a.createdTimestamp < 5000 
        );

        return { 
            executor: auditEntry ? auditEntry.executor : null, 
            reason: auditEntry ? (auditEntry.reason || 'No reason provided in Audit Log.') : null 
        };
    } catch (e) {
        console.warn(`⚠️ Failed to fetch Audit Log for types ${types.join(', ')}: ${e.message}`);
        return { executor: null, reason: null };
    }
}

/**
 * Caches all current invites for a guild.
 * @param {Guild} guild The guild object.
 */
async function cacheInvites(guild) {
    if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        // console.log(`⚠️ Bot lacks 'Manage Server' permission in ${guild.name}. Cannot track invites.`);
        return;
    }
    
    try {
        const guildInvites = await guild.invites.fetch();
        client.invites.set(guild.id, new Collection(guildInvites.map(invite => [invite.code, invite.uses])));
    } catch (e) {
        console.error(`❌ Failed to cache invites for ${guild.name}: ${e.message}`);
    }
}

// ===================================
// === COMMANDS SETUP (UNMODIFIED) ===
// ===================================

function setupCommands() {
    // !setlog command (Administrator required)
    client.commands.set('setlog', {
        name: 'setlog',
        description: 'Sets the current channel or a tagged channel as the dedicated log channel.',
        permissions: PermissionsBitField.Flags.Administrator,
        execute: async (message, args) => {
            if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return message.reply({ content: '❌ You must be an Administrator to use this command.', ephemeral: true });
            }
            
            let targetChannel = message.channel; 
            const mentionedChannel = message.mentions.channels.first();

            if (mentionedChannel) {
                if (mentionedChannel.type === 0) { 
                    targetChannel = mentionedChannel;
                } else {
                    return message.reply({ content: `❌ The channel you mentioned (${mentionedChannel}) is not a valid text channel for logging.`, ephemeral: true });
                }
            } else if (args[0]) {
                 const resolvedChannel = message.guild.channels.cache.get(args[0]) || message.guild.channels.cache.find(ch => ch.name === args[0]);

                if (resolvedChannel && resolvedChannel.type === 0) {
                    targetChannel = resolvedChannel;
                } else if (resolvedChannel) {
                    return message.reply({ content: `❌ The ID or name you provided corresponds to a channel that is not a text channel.`, ephemeral: true });
                } else {
                    return message.reply({ 
                        content: `⚠️ Could not find a channel matching \`${args[0]}\`. Using the current channel as the log channel.`,
                        ephemeral: true
                    });
                }
            }

            guildConfig[message.guild.id] = targetChannel.id;
            saveConfig();

            const embed = new EmbedBuilder()
                .setTitle('✅ Log Channel Set!')
                .setDescription(`The channel **${targetChannel.name}** (${targetChannel}) has been successfully set as the WatchDog log channel for this server.`)
                .setColor(Colors.Green);

            await message.channel.send({ embeds: [embed] });
        }
    });

    // !kick command 
    client.commands.set('kick', {
        name: 'kick',
        description: 'Kicks a user from the server.',
        permissions: PermissionsBitField.Flags.KickMembers,
        execute: async (message, args) => {
            if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
                return message.reply('❌ You do not have permission to kick members.');
            }
            const targetMember = message.mentions.members.first() || message.guild.members.cache.get(args[0]);
            if (!targetMember) {
                return message.reply(`Usage: ${PREFIX}kick <@user|id> [reason]`);
            }
            if (!targetMember.kickable) {
                return message.reply('❌ I cannot kick this user. Check my role hierarchy.');
            }

            const reason = args.slice(1).join(' ') || 'No reason provided';
            
            try {
                await targetMember.kick(reason);
                await message.channel.send({ content: `✅ Successfully kicked ${targetMember.user.tag}.` });
                // Log is handled by the guildMemberRemove event, but we ensure the command usage is logged here
                await logEvent(message.guild, '⚡ Command Used', `**Moderator:** ${message.author.tag}\n**Command:** \`!kick\`\n**Target:** ${targetMember.user.tag}`, Colors.Grey);
            } catch (error) {
                message.channel.send(`❌ An error occurred while trying to kick: ${error.message}`);
            }
        }
    });

    // !ban command 
    client.commands.set('ban', {
        name: 'ban',
        description: 'Bans a user from the server.',
        permissions: PermissionsBitField.Flags.BanMembers,
        execute: async (message, args) => {
            if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
                return message.reply('❌ You do not have permission to ban members.');
            }
            const targetUser = message.mentions.users.first() || await client.users.fetch(args[0]).catch(() => null);
            if (!targetUser) {
                return message.reply(`Usage: ${PREFIX}ban <@user|id> [reason]`);
            }

            const reason = args.slice(1).join(' ') || 'No reason provided';

            try {
                const targetMember = message.guild.members.cache.get(targetUser.id);
                if (targetMember && !targetMember.bannable) {
                     return message.reply('❌ I cannot ban this user. Check my role hierarchy.');
                }
                
                await message.guild.members.ban(targetUser.id, { reason });

                await message.channel.send({ content: `✅ Successfully banned ${targetUser.tag}.` });
                // Log is handled by guildBanAdd event. Log command usage here.
                await logEvent(message.guild, '⚡ Command Used', `**Moderator:** ${message.author.tag}\n**Command:** \`!ban\`\n**Target:** ${targetUser.tag}`, Colors.Grey);
            } catch (error) {
                message.channel.send(`❌ An error occurred while trying to ban: ${error.message}`);
            }
        }
    });

    // !help command 
    client.commands.set('help', {
        name: 'help',
        description: 'Displays all available commands and their usage.',
        permissions: null, 
        execute: async (message, args) => {
            const helpEmbed = new EmbedBuilder()
                .setTitle('WatchDog Bot Commands')
                .setColor(Colors.Blue)
                .setDescription(`My prefix is \`${PREFIX}\`. Below are the available moderation and utility commands:`);

            client.commands.forEach(command => {
                let permissionsString = 'Everyone';

                if (command.permissions) {
                    permissionsString = new PermissionsBitField(command.permissions).toArray().join(', ');
                }

                if (permissionsString === '') permissionsString = 'Everyone'; 
                
                helpEmbed.addFields({
                    name: `${PREFIX}${command.name}`, 
                    value: `> ${command.description}\n> **Required Permission:** \`${permissionsString}\``, 
                    inline: false 
                });
            });

            await message.channel.send({ embeds: [helpEmbed] });
        }
    });
}


// ===================================
// === BOT EVENTS (LOGGING) ===
// ===================================

client.on('ready', () => {
    loadConfig();
    setupCommands();
    console.log(`🤖 Logged in as ${client.user.tag}!`);
    client.user.setActivity('for suspicious activity.', { type: 3 }); 
    
    client.guilds.cache.forEach(guild => cacheInvites(guild));
});

// --- COMMAND HANDLER (INCLUDES COMMAND USAGE LOGGING) ---
client.on('messageCreate', async message => {
    if (!message.guild || !message.content.startsWith(PREFIX) || message.author.bot) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    const command = client.commands.get(commandName);

    if (!command) return;

    try {
        await command.execute(message, args);
        // Log successful command usage unless it's the logging command itself
        if (commandName !== 'setlog') {
             await logEvent(message.guild, '⚡ Command Used', 
                `**User:** ${message.author.tag} (${message.author.id})\n**Channel:** ${message.channel}\n**Command:** \`${message.content}\``, 
                Colors.Grey, message.author);
        }
    } catch (error) {
        console.error(`Error executing command ${commandName}:`, error);
        message.reply('❌ There was an error trying to execute that command! Check the console.');
    }
});


// --- MEMBER/USER EVENTS ---

// Member Join (Improved with Account Age and Invite Tracking)
client.on('guildMemberAdd', async member => {
    let description = `**User:** ${member.user.tag} (${member.id})\n`;
    description += `**Account Created:** <t:${Math.floor(member.user.createdAt.getTime() / 1000)}:f> (<t:${Math.floor(member.user.createdAt.getTime() / 1000)}:R>)`; // Account Age Log
    
    // --- INVITE TRACKING LOGIC ---
    const cachedInvites = client.invites.get(member.guild.id);
    if (cachedInvites) {
        const newInvites = await member.guild.invites.fetch();
        let usedInvite = null;

        for (const [code, invite] of newInvites) {
            const oldUses = cachedInvites.get(code) || 0;
            if (invite.uses > oldUses) {
                usedInvite = invite;
                cachedInvites.set(code, invite.uses); 
                break;
            }
        }

        if (usedInvite) {
            const creator = usedInvite.inviter ? usedInvite.inviter.tag : 'System/Unknown';
            description += `\n\n**Invite Used:** \`${usedInvite.code}\`\n**Created By:** ${creator}\n**Uses:** ${usedInvite.uses}`;
        } else {
             description += `\n\n**Invite Used:** Could not determine invite link.`;
        }
        client.invites.set(member.guild.id, new Collection(newInvites.map(invite => [invite.code, invite.uses])));
    } else {
        description += `\n\n⚠️ Invite tracking disabled.`;
    }
    // --- END INVITE TRACKING LOGIC ---

    logEvent(member.guild, '🟢 Member Joined', description, Colors.Green, member);
});

// Member Leave (Improved with Join Time)
client.on('guildMemberRemove', async member => {
    let description = `**User:** ${member.user.tag} (${member.id})\n`;
    if (member.joinedAt) { // Check if joinedAt is available
        description += `**Joined:** <t:${Math.floor(member.joinedAt.getTime() / 1000)}:f>\n`;
    } else {
        description += `**Joined:** Time unknown\n`;
    }
    
    const { executor, reason } = await getAuditLogExecutor(member.guild, AuditLogEvent.MemberKick, member.id);
    
    let title = '🔴 Member Left/Quit';
    let color = Colors.Red;

    if (executor) {
        title = '🔨 Member Kicked';
        description += `\n**Responsible Mod:** ${executor.tag} (${executor.id})\n**Reason:** ${reason || 'No reason provided.'}`;
        color = Colors.Orange;
    }

    logEvent(member.guild, title, description, color, member);
});

// Member Update (Nickname/Roles/TIMEOUT)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (oldMember.partial || newMember.partial) return;

    // 1. Nickname Change & History
    if (oldMember.nickname !== newMember.nickname) {
        // Record the new nickname
        recordNickname(newMember.guild, newMember, newMember.nickname || newMember.user.username); 

        const pastNicks = getNicknameHistory(newMember.guild.id, newMember.id);
        const description = `**Old Nick:** ${oldMember.nickname || 'None'}\n**New Nick:** ${newMember.nickname || 'None'}\n\n` +
                            `**Past Nicknames:** ${pastNicks}`;
        logEvent(newMember.guild, '📝 Nickname Changed (History Recorded)', description, Colors.Blue, newMember);
    }
    
    // 2. Role Change Logging (Unmodified)
    const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
    const removedRoles = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id));

    if (addedRoles.size > 0 || removedRoles.size > 0) {
        let description = `**User:** ${newMember.user.tag} (${newMember.id})\n`;
        let roleDetails = '';
        if (addedRoles.size > 0) {
            roleDetails += `**Roles Added:** ${addedRoles.map(r => r.name).join(', ')}\n`;
        }
        if (removedRoles.size > 0) {
            roleDetails += `**Roles Removed:** ${removedRoles.map(r => r.name).join(', ')}\n`;
        }
        logEvent(newMember.guild, '🛡️ Member Roles Updated', description + roleDetails, Colors.LuminousVividPink, newMember);
    }

    // 3. Timeout Logging (Improved with Audit Log reason)
    const oldTimeout = oldMember.communicationDisabledUntil;
    const newTimeout = newMember.communicationDisabledUntil;

    if (oldTimeout !== newTimeout) {
        const { executor, reason } = await getAuditLogExecutor(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
        const moderator = executor ? `${executor.tag} (${executor.id})` : 'Unknown Moderator';

        if (newTimeout && newTimeout > new Date()) {
            const untilTimestamp = Math.floor(newTimeout.getTime() / 1000);
            const description = `**User:** ${newMember.user.tag} (${newMember.id})\n**Moderator:** ${moderator}\n**Until:** <t:${untilTimestamp}:f> (<t:${untilTimestamp}:R>)\n**Reason:** ${reason || 'No reason provided.'}`;
            logEvent(newMember.guild, '⏳ Member Timed Out', description, Colors.DarkOrange, newMember);

        } else if (oldTimeout && oldTimeout > new Date()) {
            const description = `**User:** ${newMember.user.tag} (${newMember.id})\n**Action Performed By:** ${moderator}\n**Reason:** Timeout lifted/expired.`;
            logEvent(newMember.guild, '✅ Timeout Ended/Removed', description, Colors.Green, newMember);
        }
    }
});

// --- MESSAGE/CHANNEL EVENTS ---

// Message Delete (Updated to include WatchDog's own deleted messages)
client.on('messageDelete', async message => {
    if (!message.guild) return;
    
    // CRITICAL UPDATE: Only skip if the author exists AND it's a bot other than *this* bot
    if (message.author && message.author.bot && message.author.id !== client.user.id) return;

    // Check if this delete was part of a bulk/purge operation
    const { executor: bulkExecutor } = await getAuditLogExecutor(message.guild, AuditLogEvent.MessageBulkDelete, message.channelId);
    if (bulkExecutor) {
         // If a bulk delete happened recently, we skip logging individual messages to avoid spam
         return;
    }
    
    const authorTag = message.author ? message.author.tag : 'Unknown/Cached';
    const authorId = message.author ? message.author.id : 'Unknown';
    const isBot = message.author ? message.author.bot : false;

    let description = `**Author:** ${authorTag} (${authorId}) ${isBot ? '(BOT)' : ''}\n**Channel:** ${message.channel}\n`;
    
    if (message.content) {
        description += `\n**Content:** \n\`\`\`\n${message.content.substring(0, 1000)}\n\`\`\``;
    } 

    // Deleted Attachment Logging
    if (message.attachments.size > 0) {
        description += `\n**Deleted Attachments:** (${message.attachments.size} files)\n`;
        message.attachments.forEach(attachment => {
            // Logging the URL is the best we can do without uploading/mirroring.
            description += `- [${attachment.name}](${attachment.url})\n`; 
        });
    } else if (!message.content) {
        description += `\n**Content:** (Unknown/Empty)`;
    }

    logEvent(message.guild, '🗑️ Message Deleted', description, Colors.Red, message.author);
});

// Message Edit (Improved with Pinned Message Check)
client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (oldMessage.partial || newMessage.partial || oldMessage.author?.bot) return;

    // 1. Message Content Edit Log
    if (oldMessage.content !== newMessage.content) {
        const description = `**Author:** ${oldMessage.author.tag} (${oldMessage.author.id})\n**Channel:** ${oldMessage.channel}\n` +
            `\n**Old Content:** \n\`\`\`\n${oldMessage.content.substring(0, 500)}\n\`\`\`\n` +
            `**New Content:** \n\`\`\`\n${newMessage.content.substring(0, 500)}\n\`\`\`\n` +
            `[Jump to Message](${newMessage.url})`;

        logEvent(oldMessage.guild, '✍️ Message Edited', description, Colors.Blue, oldMessage.author);
    }
    
    // 2. Pinned Message Log
    if (oldMessage.pinned !== newMessage.pinned) {
        // Use a general Audit Log check targeting the channel, as pin/unpin is not guaranteed to have a single entry ID
        const auditLogType = newMessage.pinned ? AuditLogEvent.MessagePin : AuditLogEvent.MessageUnpin;
        const { executor, reason } = await getAuditLogExecutor(newMessage.guild, auditLogType, newMessage.channel.id);
        
        let title;
        let color;

        if (newMessage.pinned) {
            title = '📌 Message Pinned';
            color = Colors.Purple;
        } else {
            title = '📎 Message Unpinned';
            color = Colors.Grey;
        }
        
        const pinDescription = `**Action Performed By:** ${executor?.tag || 'Unknown'}\n**Channel:** ${newMessage.channel}\n**Author:** ${oldMessage.author.tag} (${oldMessage.author.id})\n[Jump to Message](${newMessage.url})`;
        
        logEvent(newMessage.guild, title, pinDescription, color, executor || oldMessage.author);
    }
});

// Channel Creation/Deletion/Update
client.on('channelCreate', channel => {
    if (!channel.guild) return; 
    let type = channel.type === 0 ? 'Text' : channel.type === 2 ? 'Voice' : 'Other';
    const description = `**Name:** ${channel.name}\n**Type:** ${type}\n**ID:** ${channel.id}`;
    logEvent(channel.guild, '➕ Channel Created', description, Colors.Green);
});

client.on('channelDelete', async channel => {
    if (!channel.guild) return;
    const { executor } = await getAuditLogExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    
    let description = `**Name:** ${channel.name}\n**ID:** ${channel.id}\n**Type:** ${channel.type}`;
    if (executor) {
        description += `\n**Responsible Mod:** ${executor.tag} (${executor.id})`;
    }

    logEvent(channel.guild, '➖ Channel Deleted', description, Colors.Red);
});

// Channel Edits & Permission Overrides
client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (!newChannel.guild || oldChannel.partial || newChannel.partial) return;
    
    let changes = [];
    if (oldChannel.name !== newChannel.name) {
        changes.push(`Name changed from \`${oldChannel.name}\` to \`${newChannel.name}\``);
    }
    if (oldChannel.topic !== newChannel.topic) {
        changes.push(`Topic was modified.`);
    }
    if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        changes.push(`Slowmode changed from \`${oldChannel.rateLimitPerUser}s\` to \`${newChannel.rateLimitPerUser}s\``);
    }

    // Permission Override Changes
    const oldPerms = oldChannel.permissionOverwrites.cache;
    const newPerms = newChannel.permissionOverwrites.cache;

    if (oldPerms.size !== newPerms.size) {
        changes.push(`Permission Overrides: Count changed from ${oldPerms.size} to ${newPerms.size}.`);
    } else {
        const changedPerms = newPerms.filter((newOverride, id) => {
            const oldOverride = oldPerms.get(id);
            if (!oldOverride) return true; 
            return oldOverride.allow.bitfield !== newOverride.allow.bitfield || oldOverride.deny.bitfield !== newOverride.deny.bitfield;
        });

        if (changedPerms.size > 0) {
            changes.push(`Permission Overrides: ${changedPerms.size} roles/users had their channel permissions modified.`);
        }
    }

    if (changes.length === 0) return;

    const { executor } = await getAuditLogExecutor(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
    const mod = executor ? `${executor.tag} (${executor.id})` : 'Unknown';

    const description = `**Channel:** ${newChannel.name} (${newChannel})\n**Moderator:** ${mod}\n\n**Changes:**\n- ${changes.join('\n- ')}`;

    logEvent(newChannel.guild, '⚙️ Channel Settings Updated', description, Colors.Yellow);
});

// Role Creation/Deletion/Update 
client.on('roleCreate', role => {
    const description = `**Name:** ${role.name}\n**Color:** #${role.color.toString(16).toUpperCase()}\n**ID:** ${role.id}`;
    logEvent(role.guild, '➕ Role Created', description, Colors.Green);
});

client.on('roleDelete', async role => {
    const { executor } = await getAuditLogExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
    
    let description = `**Name:** ${role.name}\n**ID:** ${role.id}`;
    if (executor) {
        description += `\n**Responsible Mod:** ${executor.tag} (${executor.id})`;
    }

    logEvent(role.guild, '➖ Role Deleted', description, Colors.Red);
});

client.on('roleUpdate', async (oldRole, newRole) => {
    let changes = [];
    
    if (oldRole.name !== newRole.name) {
        changes.push(`Name changed from \`${oldRole.name}\` to \`${newRole.name}\``);
    }
    if (oldRole.color !== newRole.color) {
        changes.push(`Color changed from \`#${oldRole.color.toString(16).toUpperCase()}\` to \`#${newRole.color.toString(16).toUpperCase()}\``);
    }
    if (!oldRole.permissions.equals(newRole.permissions)) {
        changes.push(`Permissions were modified.`);
    }

    if (changes.length === 0) return;

    const { executor } = await getAuditLogExecutor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    const mod = executor ? `${executor.tag} (${executor.id})` : 'Unknown';

    const description = `**Role:** ${newRole.name} (${newRole.id})\n**Moderator:** ${mod}\n\n**Changes:**\n- ${changes.join('\n- ')}`;

    logEvent(newRole.guild, '⚙️ Role Settings Updated', description, Colors.Yellow);
});

// Guild/Server Updates
client.on('guildUpdate', async (oldGuild, newGuild) => {
    let changes = [];

    if (oldGuild.name !== newGuild.name) {
        changes.push(`Name changed from \`${oldGuild.name}\` to \`${newGuild.name}\``);
    }
    if (oldGuild.iconURL() !== newGuild.iconURL()) {
        changes.push(`Icon changed.`);
    }
    if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
        const levels = ['None', 'Low', 'Medium', 'High', 'Highest'];
        changes.push(`Verification Level changed from \`${levels[oldGuild.verificationLevel]}\` to \`${levels[newGuild.verificationLevel]}\``);
    }
    if (oldGuild.systemChannelId !== newGuild.systemChannelId) {
        changes.push(`System Channel changed to ${newGuild.systemChannel || 'None'}`);
    }

    if (changes.length === 0) return;

    const { executor } = await getAuditLogExecutor(newGuild, AuditLogEvent.GuildUpdate);
    const mod = executor ? `${executor.tag} (${executor.id})` : 'Unknown/Automatic';

    const description = `**Moderator:** ${mod}\n\n**Changes:**\n- ${changes.join('\n- ')}`;
    logEvent(newGuild, '🌐 Server Settings Updated', description, Colors.DarkGreen);
});


// Ban/Unban 
client.on('guildBanAdd', async ban => {
    let description = `**User:** ${ban.user.tag} (${ban.user.id})`;
    
    const { executor, reason } = await getAuditLogExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);

    const mod = executor ? `${executor.tag} (${executor.id})` : 'Unknown';
    const logReason = reason || ban.reason || 'No reason provided.';

    description += `\n**Responsible Mod:** ${mod}\n**Reason:** ${logReason}`;

    logEvent(ban.guild, '🔨 User Banned', description, Colors.DarkRed, ban.user);
});

client.on('guildBanRemove', async ban => {
    let description = `**User:** ${ban.user.tag} (${ban.user.id})`;
    
    const { executor } = await getAuditLogExecutor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    const mod = executor ? `${executor.tag} (${executor.id})` : 'Unknown';

    description += `\n**Responsible Mod:** ${mod}`;

    logEvent(ban.guild, '🔓 User Unbanned', description, Colors.Yellow, ban.user);
});

// Voice State Update
client.on('voiceStateUpdate', (oldState, newState) => {
    const member = newState.member;
    const guild = newState.guild;

    if (!member || !guild) return; 

    // 1. Join/Leave/Switch
    if (oldState.channelId === null && newState.channelId !== null) {
        const description = `**Channel:** ${newState.channel}`;
        logEvent(guild, '🔊 Voice Joined', description, Colors.Green, member);
    } else if (oldState.channelId !== null && newState.channelId === null) {
        const description = `**Channel:** ${oldState.channel}`;
        logEvent(guild, '🔇 Voice Left', description, Colors.Red, member);
    } else if (oldState.channelId !== null && newState.channelId !== null && oldState.channelId !== newState.channelId) {
        const description = `**Old Channel:** ${oldState.channel}\n**New Channel:** ${newState.channel}`;
        logEvent(guild, '🔁 Voice Switched', description, Colors.Blue, member);
    }
    
    // 2. Mute/Deafen/Stream/Video Changes
    if (oldState.channelId !== newState.channelId) return; // Ignore if the user just moved/joined/left

    let title = '🎤 Voice State Change';
    let description = `**User:** ${member.user.tag} (${member.id})\n**Channel:** ${newState.channel}\n`;
    let color = Colors.LightGrey;

    // Self/Server Mute
    if (oldState.mute !== newState.mute) {
        title = newState.mute ? '❌ User Muted' : '✅ User Unmuted';
        description += `**Type:** ${newState.serverMute ? 'Server' : 'Self'} Mute`;
        if (newState.serverMute) color = Colors.Orange;
    } 
    // Self/Server Deafen
    else if (oldState.deaf !== newState.deaf) {
        title = newState.deaf ? '❌ User Deafened' : '✅ User Undeafened';
        description += `**Type:** ${newState.serverDeaf ? 'Server' : 'Self'} Deafen`;
        if (newState.serverDeaf) color = Colors.Orange;
    } 
    // Stream/Video Status
    else if (oldState.streaming !== newState.streaming) {
        title = newState.streaming ? '📺 Stream Started' : '🛑 Stream Stopped';
    }
    else if (oldState.selfVideo !== newState.selfVideo) {
        title = newState.selfVideo ? '📹 Video Started' : '🛑 Video Stopped';
    }
    else {
        return; // No relevant state change found
    }
    
    // Log state change
    logEvent(guild, title, description, color, member);
});


// Presence Update (Activity/Status)
client.on('presenceUpdate', (oldPresence, newPresence) => {
    if (!newPresence.guild || !newPresence.member) return;
    
    const guild = newPresence.guild;
    const user = newPresence.member.user;

    if (!guildConfig[guild.id]) return;

    let title = '';
    let description = `**User:** ${user.tag} (${user.id})\n`;
    let color = Colors.Grey;
    
    const newActivity = newPresence.activities[0];
    const oldActivity = oldPresence?.activities[0];

    // Simple check for activity name change (covers playing, custom status, etc.)
    if (newActivity?.name !== oldActivity?.name || newActivity?.type !== oldActivity?.type) {
        let activityDetails = '';
        if (newActivity) {
            let activityType = 'Activity';
            if (newActivity.type === 0) activityType = 'Playing';
            if (newActivity.type === 1) activityType = 'Streaming';
            if (newActivity.type === 4) activityType = 'Custom Status';

            title = `🕹️ ${activityType} Started`;
            activityDetails += `\n**Activity:** ${newActivity.name}`;
            if (newActivity.details) activityDetails += `\n**Details:** ${newActivity.details}`;
            color = (newActivity.type === 1) ? Colors.LuminousVividPink : Colors.Green;
        } else if (oldActivity) {
            title = '🛑 Activity Ended';
            activityDetails += `\n**Activity:** ${oldActivity.name}`;
            color = Colors.Red;
        } else {
            return; 
        }
        description += activityDetails;
    } else {
        return; 
    }

    logEvent(guild, title, description, color, user);
});

// Emoji Creation
client.on('emojiCreate', emoji => {
    const description = `**Name:** ${emoji.name}\n**ID:** ${emoji.id}\n**Animated:** ${emoji.animated ? 'Yes' : 'No'}\n**URL:** ${emoji.url}`;
    logEvent(emoji.guild, '🎨 Emoji Created', description, Colors.Green);
});

// Emoji Deletion
client.on('emojiDelete', emoji => {
    const description = `**Name:** ${emoji.name}\n**ID:** ${emoji.id}`;
    logEvent(emoji.guild, '🔥 Emoji Deleted', description, Colors.Red);
});

// Emoji Update (Renamed)
client.on('emojiUpdate', (oldEmoji, newEmoji) => {
    if (oldEmoji.name !== newEmoji.name) {
        const description = `**Old Name:** \`${oldEmoji.name}\`\n**New Name:** \`${newEmoji.name}\`\n**ID:** ${newEmoji.id}`;
        logEvent(newEmoji.guild, '✍️ Emoji Renamed', description, Colors.Blue);
    }
});

// Sticker Creation
client.on('stickerCreate', sticker => {
    const description = `**Name:** ${sticker.name}\n**ID:** ${sticker.id}\n**Description:** ${sticker.description || 'N/A'}\n**Tags:** ${sticker.tags || 'N/A'}`;
    logEvent(sticker.guild, '🖼️ Sticker Created', description, Colors.Green);
});

// Sticker Deletion
client.on('stickerDelete', sticker => {
    const description = `**Name:** ${sticker.name}\n**ID:** ${sticker.id}`;
    logEvent(sticker.guild, '💥 Sticker Deleted', description, Colors.Red);
});

// Sticker Update (Renamed/Modified)
client.on('stickerUpdate', (oldSticker, newSticker) => {
    let changes = [];
    if (oldSticker.name !== newSticker.name) {
        changes.push(`Name changed from \`${oldSticker.name}\` to \`${newSticker.name}\``);
    }
    if (oldSticker.description !== newSticker.description) {
        changes.push(`Description modified.`);
    }

    if (changes.length > 0) {
        const description = `**Sticker:** ${newSticker.name} (${newSticker.id})\n\n**Changes:**\n- ${changes.join('\n- ')}`;
        logEvent(newSticker.guild, '✍️ Sticker Updated', description, Colors.Blue);
    }
});


// ===================================
// === START BOT AND WEB SERVER ===
// ===================================

/**
 * Starts a simple Express server to handle pings from monitoring services (like UptimeRobot)
 * and prevent the host (like Replit) from idling.
 */
function startServer() {
    const app = express();

    // Health check endpoint for UptimeRobot
    app.get('/', (req, res) => {
        // We can check if the bot is actually ready before responding 'ok'
        if (client.isReady()) {
            res.status(200).send('WatchDog Bot is online and operational.');
        } else {
            // Respond 503 if the bot client isn't fully ready yet
            res.status(503).send('WatchDog Bot is initializing...');
        }
    });

    app.listen(PORT, () => {
        console.log(`📡 Web server is running on port ${PORT}.`);
        console.log(`   Use this URL for UptimeRobot monitoring.`);
    }).on('error', (err) => {
        console.error(`❌ Web server failed to start on port ${PORT}: ${err.message}`);
    });
}

// Start the Express server before logging in the bot
startServer();

client.login(BOT_TOKEN).catch(e => {
    console.error("❌ Failed to log in to Discord. Check your BOT_TOKEN:", e.message);
});