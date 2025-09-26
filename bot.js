const { Client, GatewayIntentBits } = require('discord.js');
const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');
require('dotenv').config();

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Initialize Twitter client
const twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

const readOnlyClient = twitterClient.readOnly;

// Configuration - UPDATED FOR YOUR NEEDS
const CONFIG = {
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    TWITTER_USERNAME: process.env.TWITTER_USERNAME,
    CHECK_INTERVAL: 1800000, // 30 menit (karena posting 1-2x per hari)
    MENTION_ROLE_NAME: 'Socials', // UBAH DARI @everyone ke @Socials
    FILTER_RETWEETS: true,
    FILTER_REPLIES: true,
    FILTER_QUOTES: true
};

let userId;
let lastTweetId = null;
let isInitialized = false;
let socialsRole = null;

// Get user ID from username
async function getUserId() {
    try {
        const user = await readOnlyClient.v2.userByUsername(CONFIG.TWITTER_USERNAME);
        userId = user.data.id;
        console.log(`✅ User ID untuk @${CONFIG.TWITTER_USERNAME}: ${userId}`);
        return userId;
    } catch (error) {
        console.error('❌ Error getting user ID:', error);
        throw error;
    }
}

// Get latest tweet from user  
async function getLatestTweet() {
    try {
        if (!userId) {
            await getUserId();
        }

        // Build query with filters
        let query = `from:${CONFIG.TWITTER_USERNAME}`;
        
        if (CONFIG.FILTER_RETWEETS) {
            query += ' -is:retweet';
        }
        if (CONFIG.FILTER_REPLIES) {
            query += ' -is:reply';
        }
        if (CONFIG.FILTER_QUOTES) {
            query += ' -is:quote';
        }

        const tweets = await readOnlyClient.v2.search({
            query: query,
            max_results: 10,
            'tweet.fields': ['created_at', 'public_metrics', 'attachments', 'referenced_tweets'],
            'user.fields': ['profile_image_url', 'username', 'name'],
            expansions: ['author_id', 'attachments.media_keys'],
            'media.fields': ['url', 'preview_image_url', 'type']
        });

        if (tweets.data && tweets.data.length > 0) {
            return tweets.data[0]; // Return most recent tweet
        }
        
        return null;
    } catch (error) {
        console.error('❌ Error fetching latest tweet:', error);
        return null;
    }
}

// Get Socials role from Discord
async function getSocialsRole() {
    try {
        if (!client.guilds.cache.size) {
            console.log('⚠️ Bot belum join guild apapun');
            return null;
        }

        // Get first guild (server) where bot exists
        const guild = client.guilds.cache.first();
        
        // Find role by name "Socials"
        const role = guild.roles.cache.find(r => r.name === CONFIG.MENTION_ROLE_NAME);
        
        if (role) {
            console.log(`✅ Found role @${CONFIG.MENTION_ROLE_NAME} with ID: ${role.id}`);
            return role;
        } else {
            console.log(`⚠️ Role @${CONFIG.MENTION_ROLE_NAME} tidak ditemukan di server`);
            return null;
        }
    } catch (error) {
        console.error('❌ Error getting Socials role:', error);
        return null;
    }
}

// Format tweet for Discord with @Socials mention
function formatTweetForDiscord(tweet, user, media = null) {
    const tweetUrl = `https://twitter.com/${user.username}/status/${tweet.id}`;
    const profileUrl = `https://twitter.com/${user.username}`;
    
    let text = tweet.text;
    
    // Remove t.co links if media is present
    if (media && media.length > 0) {
        text = text.replace(/https:\/\/t\.co\/\w+/g, '').trim();
    }

    // Create embed object
    const embed = {
        color: 0x1DA1F2, // Twitter blue
        author: {
            name: `${user.name} (@${user.username})`,
            icon_url: user.profile_image_url,
            url: profileUrl
        },
        description: text,
        url: tweetUrl,
        timestamp: tweet.created_at,
        footer: {
            text: "Twitter",
            icon_url: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/twitter/twitter-original.svg"
        }
    };

    // Add metrics if available
    if (tweet.public_metrics) {
        embed.fields = [
            {
                name: "❤️ Likes",
                value: tweet.public_metrics.like_count.toString(),
                inline: true
            },
            {
                name: "🔄 Retweets", 
                value: tweet.public_metrics.retweet_count.toString(),
                inline: true
            },
            {
                name: "💬 Replies",
                value: tweet.public_metrics.reply_count.toString(), 
                inline: true
            }
        ];
    }

    // Add image if present
    if (media && media.length > 0) {
        const imageMedia = media.find(m => m.type === 'photo');
        if (imageMedia && imageMedia.url) {
            embed.image = {
                url: imageMedia.url
            };
        }
    }

    return embed;
}

// Send tweet to Discord with @Socials mention
async function sendTweetToDiscord(tweet, user, media = null) {
    try {
        const embed = formatTweetForDiscord(tweet, user, media);
        
        // Create mention - prioritas: role mention > @everyone > plain text
        let mentionText = "🐦 **Tweet baru!**";
        
        if (socialsRole) {
            mentionText = `${socialsRole} 🐦 **Tweet baru!**`; // Mention @Socials role
        } else {
            // Fallback ke @everyone jika role tidak ditemukan
            mentionText = "@everyone 🐦 **Tweet baru!**";
            console.log('⚠️ Menggunakan @everyone karena role @Socials tidak ditemukan');
        }

        const payload = {
            content: mentionText,
            embeds: [embed]
        };

        const response = await axios.post(CONFIG.DISCORD_WEBHOOK_URL, payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 204) {
            console.log(`✅ Tweet berhasil dikirim ke Discord: ${tweet.id}`);
            return true;
        } else {
            console.error('❌ Error sending to Discord:', response.status, response.data);
            return false;
        }
    } catch (error) {
        console.error('❌ Error sending tweet to Discord:', error.message);
        return false;
    }
}

// Check for new tweets
async function checkForNewTweets() {
    try {
        console.log(`🔍 Checking for new tweets... (${new Date().toLocaleString()})`);
        
        const latestTweet = await getLatestTweet();
        
        if (!latestTweet) {
            console.log('📭 No tweets found');
            return;
        }

        // Initialize lastTweetId on first run
        if (!isInitialized) {
            lastTweetId = latestTweet.id;
            isInitialized = true;
            console.log(`🚀 Bot initialized. Latest tweet ID: ${lastTweetId}`);
            return;
        }

        // Check if this is a new tweet
        if (lastTweetId && latestTweet.id === lastTweetId) {
            console.log('📝 No new tweets');
            return;
        }

        console.log(`🆕 New tweet detected: ${latestTweet.id}`);
        
        // Get tweet details including user info and media
        const tweetDetail = await readOnlyClient.v2.singleTweet(latestTweet.id, {
            'tweet.fields': ['created_at', 'public_metrics', 'attachments'],
            'user.fields': ['profile_image_url', 'username', 'name'],
            expansions: ['author_id', 'attachments.media_keys'],
            'media.fields': ['url', 'preview_image_url', 'type']
        });

        const tweet = tweetDetail.data;
        const user = tweetDetail.includes?.users?.[0];
        const media = tweetDetail.includes?.media;

        if (user) {
            const success = await sendTweetToDiscord(tweet, user, media);
            if (success) {
                lastTweetId = tweet.id;
                console.log(`✅ Updated lastTweetId to: ${lastTweetId}`);
            }
        }
        
    } catch (error) {
        console.error('❌ Error in checkForNewTweets:', error);
    }
}

// Discord bot events
client.once('ready', async () => {
    console.log(`✅ Discord bot logged in as ${client.user.tag}!`);
    
    // Get Socials role
    socialsRole = await getSocialsRole();
    
    // Start checking for tweets
    console.log(`🔄 Starting tweet monitoring for @${CONFIG.TWITTER_USERNAME}`);
    console.log(`⏰ Check interval: ${CONFIG.CHECK_INTERVAL / 1000 / 60} minutes (optimized for 1-2 posts/day)`);
    
    // Initial check
    checkForNewTweets();
    
    // Set up interval - sekarang 30 menit instead of 60 detik
    setInterval(checkForNewTweets, CONFIG.CHECK_INTERVAL);
});

client.on('error', (error) => {
    console.error('❌ Discord client error:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down bot...');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down bot...');
    client.destroy();
    process.exit(0);
});

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled promise rejection:', error);
});

// Health check endpoint for hosting platforms
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot is running',
        lastCheck: new Date().toISOString(),
        interval: `${CONFIG.CHECK_INTERVAL / 1000 / 60} minutes`
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        botReady: client.isReady(),
        uptime: process.uptime()
    });
});

app.listen(PORT, () => {
    console.log(`🌐 Health check server running on port ${PORT}`);
});

// Validation
function validateConfig() {
    const required = [
        'TWITTER_API_KEY',
        'TWITTER_API_SECRET', 
        'TWITTER_ACCESS_TOKEN',
        'TWITTER_ACCESS_SECRET',
        'DISCORD_BOT_TOKEN',
        'DISCORD_WEBHOOK_URL',
        'TWITTER_USERNAME'
    ];

    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        console.error('❌ Missing required environment variables:');
        missing.forEach(key => console.error(`   - ${key}`));
        console.error('\n📝 Please check your .env file');
        process.exit(1);
    }

    // Validate webhook URL format
    if (!CONFIG.DISCORD_WEBHOOK_URL.includes('discord.com/api/webhooks/')) {
        console.error('❌ Invalid Discord webhook URL format');
        process.exit(1);
    }

    console.log('✅ Configuration validated');
}

// Start the bot
async function startBot() {
    try {
        console.log('🚀 Starting Twitter to Discord Bot (Updated Version)...');
        console.log('=================================================');
        
        validateConfig();
        
        // Login to Discord
        await client.login(process.env.DISCORD_BOT_TOKEN);
        
    } catch (error) {
        console.error('❌ Failed to start bot:', error);
        process.exit(1);
    }
}

// Start the bot
startBot();
