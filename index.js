const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const app = express();
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);
app.use(express.json());

// Хранилище состояний и ID сообщений бота
const state = {};
const messageIds = {};

// Шкала для кубов судьбы
const fateResultNames = {
  '-4': 'Ужасающий',
  '-3': 'Катастрофический',
  '-2': 'Ужасный',
  '-1': 'Плохой',
  '0': 'Средний',
  '1': 'Посредственный',
  '2': 'Хороший',
  '3': 'Эпический',
  '4': 'Легендарный'
};

// Webhook
app.post('/', (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error('Error processing webhook update:', e.message);
    res.sendStatus(500);
  }
});

bot.setWebHook(`https://epicforgedicebot.onrender.com`);

// Обработка /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    sendMainMenu(chatId, msg.message_id);
  } catch (e) {
    console.error('Error handling /start:', e.message);
  }
});

// Обработка callback-запросов (инлайн-кнопки)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const queryId = query.id;
  console.log(`Received callback_query: chatId=${chatId}, data=${query.data}`);

  // Подтверждаем callback
  try {
    await bot.answerCallbackQuery(queryId);
  } catch (e) {
    console.error('Error answering callback query:', e.message);
  }

  // Удаляем сообщение бота с меню
  try {
    await bot.deleteMessage(chatId, messageId);
    delete messageIds[`menu_${chatId}`];
  } catch (e) {
    console.error('Error deleting menu message:', e.message);
  }

  if (query.data === 'explosive_dice') {
    state[chatId] = 'awaiting_formula';
    try {
      const sent = await bot.sendMessage(chatId, 'Введи формулу (2d6+1d8-1 или 1d20!) в поле ввода и нажми "Отправить" в Telegram. Для кубов судьбы нажми <b>Судьба</b>:', {
        reply_markup: {
          keyboard: [
            ['Судьба', 'НАЗАД']
          ],
          resize_keyboard: true,
          one_time_keyboard: false
        },
        parse_mode: 'HTML'
      });
      messageIds[`prompt_${chatId}`] = { id: sent.message_id, timestamp: Date.now() };
    } catch (e) {
      console.error('Error sending formula prompt:', e.message);
    }
  } else if (query.data === 'regular_fate_dice') {
    state[chatId] = 'regular_fate';
    try {
      const sent = await bot.sendMessage(chatId, 'Выбери куб для броска:', {
        reply_markup: {
          keyboard: [
            ['1d4', '1d6', '1d8'],
            ['1d10', '1d12', '1d20'],
            ['1d100', 'Судьба'],
            ['Назад']
          ],
          resize_keyboard: true,
          one_time_keyboard: false
        }
      });
      messageIds[`dice_menu_${chatId}`] = { id: sent.message_id, timestamp: Date.now() };
    } catch (e) {
      console.error('Error sending dice menu:', e.message);
    }
  }
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const messageId = msg.message_id;
  console.log(`Received message: chatId=${chatId}, text=${text}`);

  if (text.startsWith('/')) return;

  if (state[chatId] === 'awaiting_formula') {
    if (text === 'НАЗАД') {
      if (messageIds[`prompt_${chatId}`]) {
        try {
          await bot.deleteMessage(chatId, messageIds[`prompt_${chatId}`].id);
          delete messageIds[`prompt_${chatId}`];
        } catch (e) {
          console.error('Error deleting prompt:', e.message);
        }
      }
      try {
        await bot.sendMessage(chatId, 'Клавиатура убрана', {
          reply_to_message_id: messageId,
          reply_markup: { remove_keyboard: true }
        });
        delete state[chatId];
        sendMainMenu(chatId, messageId);
      } catch (e) {
        console.error('Error sending back response:', e.message);
      }
      return;
    }
    if (text === 'Судьба') {
      try {
        const result = rollFateDice();
        const sent = await bot.sendMessage(chatId, `Бросок ${result.rolls.join(' + ')} = ${result.total}${result.fateResult ? `\nРезультат: ${result.fateResult}` : ''}`, {
          reply_to_message_id: messageId,
          parse_mode: 'HTML'
        });
        messageIds[`result_${chatId}_${sent.message_id}`] = { id: sent.message_id, timestamp: Date.now() };
      } catch (e) {
        console.error('Error processing fate dice:', e.message);
      }
      return;
    }
    try {
      const result = parseAndRoll(text);
      const sent = await bot.sendMessage(chatId, `Бросок ${result.rolls.join(' + ')} = ${result.total}${result.fateResult ? `\nРезультат: ${result.fateResult}` : ''}`, {
        reply_to_message_id: messageId,
        parse_mode: 'HTML'
      });
      messageIds[`result_${chatId}_${sent.message_id}`] = { id: sent.message_id, timestamp: Date.now() };
    } catch (e) {
      console.error('Error processing formula:', e.message);
      await bot.sendMessage(chatId, 'Неверная формула. Пример: 2d6+1d8-1 или 1d20! или 4f', {
        reply_to_message_id: messageId
      });
    }
  } else if (state[chatId] === 'regular_fate') {
    if (text === 'Назад') {
      if (messageIds[`dice_menu_${chatId}`]) {
        try {
          await bot.deleteMessage(chatId, messageIds[`dice_menu_${chatId}`].id);
          delete messageIds[`dice_menu_${chatId}`];
        } catch (e) {
          console.error('Error deleting dice menu:', e.message);
        }
      }
      try {
        await bot.sendMessage(chatId, 'Клавиатура убрана', {
          reply_to_message_id: messageId,
          reply_markup: { remove_keyboard: true }
        });
        delete state[chatId];
        sendMainMenu(chatId, messageId);
      } catch (e) {
        console.error('Error sending back response:', e.message);
      }
      return;
    }
    let result;
    try {
      if (text === 'Судьба') {
        result = rollFateDice();
      } else if (/1d\d+/.test(text)) {
        const sides = parseInt(text.match(/1d(\d+)/)[1]);
        const roll = Math.floor(Math.random() * sides) + 1;
        result = { total: roll, rolls: [`${roll} [d${sides}]`] };
      } else {
        result = { total: 0, rolls: ['Неверный выбор куба'] };
      }
      const sent = await bot.sendMessage(chatId, `Бросок ${result.rolls.join(' + ')} = ${result.total}${result.fateResult ? `\nРезультат: ${result.fateResult}` : ''}`, {
        reply_to_message_id: messageId,
        parse_mode: 'HTML'
      });
      messageIds[`result_${chatId}_${sent.message_id}`] = { id: sent.message_id, timestamp: Date.now() };
    } catch (e) {
      console.error('Error processing dice selection:', e.message);
    }
  } else {
    try {
      await bot.sendMessage(chatId, 'Используй /start для начала', { reply_to_message_id: messageId });
    } catch (e) {
      console.error('Error sending default response:', e.message);
    }
  }
});

// Главное меню
function sendMainMenu(chatId, replyToMessageId) {
  try {
    bot.sendMessage(chatId, '🎲 Выбери режим:', {
      reply_to_message_id: replyToMessageId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Взрывные/Ввод', callback_data: 'explosive_dice' },
            { text: '1Dx/Судьба', callback_data: 'regular_fate_dice' }
          ]
        ]
      }
    }).then(sent => {
      messageIds[`menu_${chatId}`] = { id: sent.message_id, timestamp: Date.now() };
    });
  } catch (e) {
    console.error('Error sending main menu:', e.message);
  }
}

// Парсинг и бросок кубов
function parseAndRoll(formula) {
  const regex = /(\d+[df]\d*!?|\d+[df])(?:\s*([+-])\s*(\d+[df]\d*!?|\d+[df]|\d+))*/;
  if (!regex.test(formula)) return { total: 0, rolls: ['Неверная формула. Пример: 2d6+1d8-1 или 1d20! или 4f'] };

  const parts = formula.replace(/\s/g, '').split(/([+-])/).filter(p => p);
  let results = [];
  let total = 0;
  let fateResult = '';

  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    if (part === '+' || part === '-') continue;
    if (/^\d+$/.test(part)) {
      const value = parseInt(part);
      total += (parts[i - 1] === '-' ? -1 : 1) * value;
      results.push(`(${parts[i - 1] || '+'}${part})`);
      continue;
    }
    const match = part.match(/(\d+)([df])(\d+)?(!)?/);
    if (!match) continue;
    const count = parseInt(match[1]);
    const type = match[2];
    const sides = match[3] ? parseInt(match[3]) : null;
    const isExplosive = !!match[4];
    let rolls = [];

    if (type === 'd') {
      for (let j = 0; j < count; j++) {
        let roll = Math.floor(Math.random() * sides) + 1;
        rolls.push(roll);
        if (isExplosive && roll === sides) {
          while (roll === sides) {
            roll = Math.floor(Math.random() * sides) + 1;
            rolls.push(roll);
          }
        }
      }
      const sum = rolls.reduce((a, b) => a + b, 0);
      total += (parts[i - 1] === '-' ? -1 : 1) * sum;
      results.push(`${rolls.join(', ')} [d${sides}${isExplosive ? '!' : ''}]`);
    } else if (type === 'f') {
      rolls = Array(count).fill().map(() => {
        const r = Math.random();
        return r < 0.33 ? -1 : r < 0.66 ? 0 : 1;
      });
      const sum = rolls.reduce((a, b) => a + b, 0);
      total += (parts[i - 1] === '-' ? -1 : 1) * sum;
      results.push(`4f: [${rolls.map(r => r === -1 ? ' - ' : r === 0 ? '   ' : ' + ').join(' | ')}]`);
      fateResult = `<b>${fateResultNames[sum] || ''}</b>`;
    }
  }

  return { total, rolls: results, fateResult };
}

// Бросок кубов судьбы
function rollFateDice() {
  const rolls = Array(4).fill().map(() => {
    const r = Math.random();
    return r < 0.33 ? -1 : r < 0.66 ? 0 : 1;
  });
  const total = rolls.reduce((sum, r) => sum + r, 0);
  return {
    total,
    rolls: [`4f: [${rolls.map(r => r === -1 ? ' - ' : r === 0 ? '   ' : ' + ').join(' | ')}]`],
    fateResult: `<b>${fateResultNames[total] || ''}</b>`
  };
}

// Чистка старых сообщений бота
setInterval(async () => {
  const now = Date.now();
  for (const key in messageIds) {
    if (key.startsWith('result_') && now - messageIds[key].timestamp > 3600000) {
      const [_, chatId, id] = key.split('_');
      try {
        await bot.deleteMessage(chatId, id);
        delete messageIds[key];
      } catch (e) {
        console.error('Error deleting old result:', e.message);
      }
    }
  }
}, 3600000);

app.listen(3000, () => {
  console.log('Bot server running on port 3000');
});
