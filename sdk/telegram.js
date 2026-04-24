/**
 * PIPEE Telegram Helper
 *
 * Any sub-project can send Telegram messages through tg-proxy.
 * Auto-reads proxy URL and bot credentials from PIPEE config.
 *
 * Usage:
 *   const tg = require('../../sdk/telegram')
 *   await tg.send('Hello from my project!')
 *   await tg.sendPhoto(photoUrl, 'Caption here')
 *   await tg.notify('Deploy done', { parse_mode: 'HTML' })
 */

const { readFileSync } = require('fs')
const { join } = require('path')

const CONFIG_PATH = join(__dirname, '..', 'config.json')

function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function createTelegram(opts = {}) {
  const config = loadConfig()
  const tgConfig = config.telegram || {}

  const proxyUrl = opts.proxyUrl
    || process.env.TELEGRAM_PROXY
    || config.telegramProxy
    || null
  const botToken = opts.botToken
    || process.env.TELEGRAM_BOT_TOKEN
    || tgConfig.botToken
    || ''
  const defaultChatId = opts.chatId
    || process.env.TELEGRAM_CHAT_ID
    || tgConfig.chatId
    || ''

  const apiBase = proxyUrl
    ? `${proxyUrl.replace(/\/+$/, '')}/bot${botToken}`
    : `https://api.telegram.org/bot${botToken}`

  async function api(method, body = {}) {
    const url = `${apiBase}/${method}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await res.json()
    if (!data.ok) {
      const err = new Error(data.description || `Telegram API error: ${method}`)
      err.code = data.error_code
      throw err
    }

    return data.result
  }

  return {
    /**
     * Send a text message to the default chat
     * @param {string} text - message text
     * @param {object} [extra] - extra params (parse_mode, reply_markup, etc.)
     */
    send(text, extra = {}) {
      return api('sendMessage', {
        chat_id: extra.chat_id || defaultChatId,
        text,
        ...extra,
      })
    },

    /**
     * Alias for send — semantic name for notifications
     */
    notify(text, extra = {}) {
      return this.send(text, extra)
    },

    /**
     * Send a photo
     * @param {string} photo - URL or file_id
     * @param {string} [caption]
     * @param {object} [extra]
     */
    sendPhoto(photo, caption, extra = {}) {
      return api('sendPhoto', {
        chat_id: extra.chat_id || defaultChatId,
        photo,
        caption,
        ...extra,
      })
    },

    /**
     * Send a document
     * @param {string} document - URL or file_id
     * @param {string} [caption]
     * @param {object} [extra]
     */
    sendDocument(document, caption, extra = {}) {
      return api('sendDocument', {
        chat_id: extra.chat_id || defaultChatId,
        document,
        caption,
        ...extra,
      })
    },

    /**
     * Raw Telegram Bot API call
     * @param {string} method - e.g. 'sendMessage', 'getMe'
     * @param {object} [body]
     */
    api,

    /** The resolved API base URL (for debugging) */
    apiBase,
  }
}

// Default singleton
const defaultClient = createTelegram()

module.exports = defaultClient
module.exports.createTelegram = createTelegram
