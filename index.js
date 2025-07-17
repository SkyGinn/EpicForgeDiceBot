const { Telegraf } = require('telegraf');
const { MongoClient } = require('mongodb');
const moment = require('moment-timezone');

const bot = new Telegraf(process.env.BOT_TOKEN);
const mongoUri = process.env.MONGODB_URI;
const adminId = process.env.ADMIN_ID;

const client = new MongoClient(mongoUri);
let db;

// Состояния для ожидания ввода
const userStates = {};

// Подключение к MongoDB
async function connectToMongo() {
  await client.connect();
  db = client.db('dicebot');
  console.log('Connected to MongoDB');
}

// Проверка активности Мастеров (раз в минуту)
setInterval(async () => {
  const masters = await db.collection('masters').find().toArray();
  const now = Date.now();
  for (const master of masters) {
    if (master.isActive && now - master.activatedAt > 24 * 60 * 60 * 1000) {
      await db.collection('masters').updateOne(
        { _id: master._id },
        { $set: { isActive: false } }
      );
    }
  }
}, 60 * 1000);

// Генерация кода приглашения
function generateInviteCode() {
  return `MASTER_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
}

// Парсинг формулы кубов
function parseDiceFormula(formula) {
  const diceRegex = /^(\d*)d(\d+)([+-]?\d*)?(!)?$/i;
  const fateRegex = /^(\d*)f$/i;
  if (diceRegex.test(formula)) {
    const [, count = '1', sides, modifier = '0', explode] = formula.match(diceRegex);
    return { type: 'dice', count: parseInt(count), sides: parseInt(sides), modifier: parseInt(modifier || '0'), explode: !!explode };
  } else if (fateRegex.test(formula)) {
    const [, count = '4'] = formula.match(fateRegex);
    return { type: 'fate', count: parseInt(count) };
  }
  return null;
}

// Выполнение броска
function rollDice(formula) {
  const parsed = parseDiceFormula(formula);
  if (!parsed) return null;
  const { type, count, sides, modifier, explode } = parsed;
  if (type === 'dice') {
    const rolls = [];
    let total = modifier;
    for (let i = 0; i < count; i++) {
      const roll = Math.floor(Math.random() * sides) + 1;
      rolls.push(roll);
      total += roll;
      if (explode && roll === sides) i--;
    }
    return { rolls, total, sides, modifier };
  } else if (type === 'fate') {
    const rolls = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      const roll = Math.floor(Math.random() * 3) - 1; // -1, 0, +1
      rolls.push(roll);
      total += roll;
    }
    return { rolls, total };
  }
  return null;
}

// Форматирование результата
function formatResult(formula, result) {
  if (!result) return 'Неверная формула!';
  if (result.sides) {
    const rollStr = result.rolls.map(r => `${r} [d${result.sides}]`).join(', ');
    const modStr = result.modifier ? ` + (${result.modifier})` : '';
    return `Бросок ${rollStr}${modStr} = ${result.total}`;
  } else {
    const rollStr = result.rolls.map(r => r === 1 ? '+' : r === 0 ? ' ' : '-').join(' | ');
    const resultStr = result.total > 0 ? 'Хорошо' : result.total < 0 ? 'Плохо' : 'Посредственно';
    return `Бросок судьбы: ${rollStr} = ${result.total}\nРезультат: ${resultStr}`;
  }
}

// Форматирование проверки
function formatCheck(formula, dc, result) {
  if (!result) return 'Неверная формула!';
  const rollStr = result.rolls.map(r => `${r} [d${result.sides}]`).join(', ');
  const modStr = result.modifier ? ` + (${result.modifier})` : '';
  const success = result.total >= dc ? 'Успех' : 'Провал';
  return `Проверка: ${rollStr}${modStr} = ${result.total} (${success} против DC ${dc})`;
}

// Форматирование судьбы против DC
function formatFateCheck(dc, result) {
  const rollStr = result.rolls.map(r => r === 1 ? '+' : r === 0 ? ' ' : '-').join(' | ');
  const resultStr = result.total >= dc ? 'Успех' : 'Провал';
  return `Проверка судьбы: ${rollStr} = ${result.total}\nРезультат: ${resultStr} (против DC ${dc})`;
}

// Проверка, является ли пользователь Мастером
async function isMaster(userId, groupId) {
  const master = await db.collection('masters').findOne({ userId: userId.toString(), groupId: groupId.toString(), isActive: true });
  return !!master;
}

// Проверка, является ли пользователь админом
function isAdmin(userId) {
  return userId.toString() === adminId;
}

// Запуск бота
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  if (chatId < 0) { // УЛИЦА
    const masters = await db.collection('masters').find({ groupId: chatId.toString(), isActive: true }).toArray();
    if (masters.length === 0) {
      await ctx.reply('Подтверди силу Мастера!', {
        reply_markup: {
          inline_keyboard: [[{ text: 'Подтверди силу Мастера!', callback_data: 'confirm_master' }]]
        }
      });
    } else {
      await ctx.reply('Выбери режим:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'nDx+!+F/Судьба', callback_data: 'dice_mode' }],
            [{ text: '1Dx/Судьба', callback_data: 'single_dice_mode' }]
          ]
        }
      });
    }
  } else { // ДОМ
    const master = await db.collection('masters').findOne({ userId: userId.toString() });
    const isAdminUser = isAdmin(userId);
    const keyboard = [
      [{ text: 'cfg', callback_data: 'open_config' }],
      [{ text: 'nDx+!+F/Судьба', callback_data: 'dice_mode' }],
      [{ text: '1Dx/Судьба', callback_data: 'single_dice_mode' }]
    ];
    if (master) {
      keyboard.push(
        [{ text: 'Проверка', callback_data: 'check' }],
        [{ text: 'Судьба против DC', callback_data: 'fate_check' }]
      );
    }
    if (isAdminUser) {
      keyboard.push([{ text: 'Админ-панель', callback_data: 'admin_panel' }]);
    }
    await ctx.reply('Выбери режим:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  }
});

// Обработка кнопок
bot.action('dice_mode', async (ctx) => {
  await ctx.deleteMessage();
  userStates[ctx.from.id] = { state: 'awaiting_dice_formula' };
  await ctx.reply('Введи формулу: nDx[+m][!] или nF (например, 2d6+1d8, 4f):');
});

bot.action('single_dice_mode', async (ctx) => {
  await ctx.deleteMessage();
  userStates[ctx.from.id] = { state: 'awaiting_single_dice' };
  await ctx.reply('Введи куб: 1Dx или F (например, 1d20, F):');
});

bot.action('check', async (ctx) => {
  const userId = ctx.from.id;
  if (await isMaster(userId, ctx.chat.id.toString())) {
    await ctx.deleteMessage();
    userStates[userId] = { state: 'awaiting_check' };
    await ctx.reply('Введи формулу и DC: nDx[+m] DC (например, 1d20+5 15):');
  } else {
    await ctx.answerCbQuery('Ты не Мастер!');
  }
});

bot.action('fate_check', async (ctx) => {
  const userId = ctx.from.id;
  if (await isMaster(userId, ctx.chat.id.toString())) {
    await ctx.deleteMessage();
    userStates[userId] = { state: 'awaiting_fate_check' };
    await ctx.reply('Введи DC: (например, 2):');
  } else {
    await ctx.answerCbQuery('Ты не Мастер!');
  }
});

bot.action('open_config', async (ctx) => {
  const userId = ctx.from.id;
  if (await db.collection('masters').findOne({ userId: userId.toString() })) {
    await ctx.deleteMessage();
    await ctx.reply('Настройки Мастера:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Активация', callback_data: 'reactivate_master' }],
          [{ text: 'Деактивация', callback_data: 'deactivate_master' }]
        ]
      }
    });
  } else {
    await ctx.answerCbQuery('Ты не Мастер!');
  }
});

bot.action('admin_panel', async (ctx) => {
  const userId = ctx.from.id;
  if (isAdmin(userId)) {
    await ctx.deleteMessage();
    await ctx.reply('Админ-панель:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Сгенерировать код', callback_data: 'generate_invite' }],
          [{ text: 'Список Мастеров', callback_data: 'list_masters' }],
          [{ text: 'Удалить Мастера', callback_data: 'remove_master' }],
          [{ text: 'Деактивировать Мастера', callback_data: 'deactivate_master_admin' }]
        ]
      }
    });
  } else {
    await ctx.answerCbQuery('Ты не админ!');
  }
});

bot.action('generate_invite', async (ctx) => {
  const userId = ctx.from.id;
  if (isAdmin(userId)) {
    const code = generateInviteCode();
    const now = Date.now();
    await db.collection('invites').insertOne({
      code,
      used: false,
      createdBy: userId.toString(),
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000
    });
    await ctx.deleteMessage();
    await ctx.reply(code);
  } else {
    await ctx.answerCbQuery('Ты не админ!');
  }
});

bot.action('list_masters', async (ctx) => {
  const userId = ctx.from.id;
  if (isAdmin(userId)) {
    const masters = await db.collection('masters').find().toArray();
    let response = 'Мастера:\n';
    masters.forEach((m, i) => {
      response += `${i + 1}. ${m.username}, группа: ${m.groupName}, активен: ${m.isActive ? 'да' : 'нет'}\n`;
    });
    await ctx.deleteMessage();
    await ctx.reply(response || 'Мастера не найдены.');
  } else {
    await ctx.answerCbQuery('Ты не админ!');
  }
});

bot.action('remove_master', async (ctx) => {
  const userId = ctx.from.id;
  if (isAdmin(userId)) {
    const masters = await db.collection('masters').find().toArray();
    const keyboard = masters.map(m => [{ text: `${m.username} - ${m.groupName}`, callback_data: `remove_${m.userId}_${m.groupId}` }]);
    await ctx.deleteMessage();
    await ctx.reply('Выбери Мастера для удаления:', {
      reply_markup: { inline_keyboard: keyboard.length ? keyboard : [[{ text: 'Нет Мастеров', callback_data: 'noop' }]] }
    });
  } else {
    await ctx.answerCbQuery('Ты не админ!');
  }
});

bot.action(/remove_(.+)_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  if (isAdmin(userId)) {
    const [, masterId, groupId] = ctx.match;
    const master = await db.collection('masters').findOne({ userId: masterId, groupId });
    await db.collection('masters').deleteOne({ userId: masterId, groupId });
    await ctx.deleteMessage();
    await ctx.reply(`Мастер ${master.username} удалён из группы ${master.groupName}`);
  } else {
    await ctx.answerCbQuery('Ты не админ!');
  }
});

bot.action('deactivate_master_admin', async (ctx) => {
  const userId = ctx.from.id;
  if (isAdmin(userId)) {
    const masters = await db.collection('masters').find({ isActive: true }).toArray();
    const keyboard = masters.map(m => [{ text: `${m.username} - ${m.groupName}`, callback_data: `deactivate_admin_${m.userId}_${m.groupId}` }]);
    await ctx.deleteMessage();
    await ctx.reply('Выбери Мастера для деактивации:', {
      reply_markup: { inline_keyboard: keyboard.length ? keyboard : [[{ text: 'Нет активных Мастеров', callback_data: 'noop' }]] }
    });
  } else {
    await ctx.answerCbQuery('Ты не админ!');
  }
});

bot.action(/deactivate_admin_(.+)_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  if (isAdmin(userId)) {
    const [, masterId, groupId] = ctx.match;
    const master = await db.collection('masters').findOne({ userId: masterId, groupId });
    await db.collection('masters').updateOne(
      { userId: masterId, groupId },
      { $set: { isActive: false } }
    );
    await ctx.deleteMessage();
    await ctx.reply(`Мастер ${master.username} деактивирован в группе ${master.groupName}`);
  } else {
    await ctx.answerCbQuery('Ты не админ!');
  }
});

bot.action('reactivate_master', async (ctx) => {
  const userId = ctx.from.id;
  const masters = await db.collection('masters').find({ userId: userId.toString() }).toArray();
  if (masters.length) {
    if (masters.length === 1) {
      await db.collection('masters').updateOne(
        { userId: userId.toString(), groupId: masters[0].groupId },
        { $set: { isActive: true, activatedAt: Date.now() } }
      );
      await ctx.deleteMessage();
      await ctx.reply(`Твоя мощь пробудилась в ${masters[0].groupName}!`);
    } else {
      const keyboard = masters.map(m => [{ text: m.groupName, callback_data: `reactivate_group_${m.groupId}` }]);
      await ctx.deleteMessage();
      await ctx.reply('Выбери группу для активации:', {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  } else {
    await ctx.answerCbQuery('Ты не Мастер!');
  }
});

bot.action(/reactivate_group_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const [, groupId] = ctx.match;
  const master = await db.collection('masters').findOne({ userId: userId.toString(), groupId });
  if (master) {
    await db.collection('masters').updateOne(
      { userId: userId.toString(), groupId },
      { $set: { isActive: true, activatedAt: Date.now() } }
    );
    await ctx.deleteMessage();
    await ctx.reply(`Твоя мощь пробудилась в ${master.groupName}!`);
  } else {
    await ctx.answerCbQuery('Ты не Мастер в этой группе!');
  }
});

bot.action('deactivate_master', async (ctx) => {
  const userId = ctx.from.id;
  const masters = await db.collection('masters').find({ userId: userId.toString(), isActive: true }).toArray();
  if (masters.length) {
    if (masters.length === 1) {
      await db.collection('masters').updateOne(
        { userId: userId.toString(), groupId: masters[0].groupId },
        { $set: { isActive: false } }
      );
      await ctx.deleteMessage();
      await ctx.reply(`Ты ушёл в тень из ${masters[0].groupName}!`);
    } else {
      const keyboard = masters.map(m => [{ text: m.groupName, callback_data: `deactivate_group_${m.groupId}` }]);
      await ctx.deleteMessage();
      await ctx.reply('Выбери группу для деактивации:', {
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  } else {
    await ctx.answerCbQuery('Ты не активный Мастер!');
  }
});

bot.action(/deactivate_group_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const [, groupId] = ctx.match;
  const master = await db.collection('masters').findOne({ userId: userId.toString(), groupId });
  if (master) {
    await db.collection('masters').updateOne(
      { userId: userId.toString(), groupId },
      { $set: { isActive: false } }
    );
    await ctx.deleteMessage();
    await ctx.reply(`Ты ушёл в тень из ${master.groupName}!`);
  } else {
    await ctx.answerCbQuery('Ты не Мастер в этой группе!');
  }
});

bot.action('confirm_master', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  const groupName = ctx.chat.title || 'Безымянный притон';

  if (userStates[userId]?.state === 'awaiting_group_confirmation') {
    const { inviteCode } = userStates[userId];
    const invite = await db.collection('invites').findOne({ code: inviteCode, used: false, expiresAt: { $gt: Date.now() } });
    if (invite) {
      await db.collection('masters').insertOne({
        userId: userId.toString(),
        username,
        groupId: chatId.toString(),
        groupName,
        inviteCode,
        isActive: true,
        activatedAt: Date.now()
      });
      await db.collection('invites').updateOne({ code: inviteCode }, { $set: { used: true } });
      delete userStates[userId];
      await ctx.deleteMessage();
      await ctx.reply(`${username} теперь МАСТЕР этого притона!`);
      await bot.telegram.sendMessage(userId, `Ты зарегистрирован как Мастер для ${groupName}!`);
      await ctx.reply('Выбери режим:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'nDx+!+F/Судьба', callback_data: 'dice_mode' }],
            [{ text: '1Dx/Судьба', callback_data: 'single_dice_mode' }]
          ]
        }
      });
    } else {
      await ctx.deleteMessage();
      const msg = await ctx.reply('Ты врёшь не тем СИЛАМ, шакалина!');
      setTimeout(() => {
        bot.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
        bot.telegram.sendMessage(chatId, 'Сосал???').then(sosMsg => {
          setTimeout(() => bot.telegram.deleteMessage(chatId, sosMsg.message_id).catch(() => {}), 2000);
        });
      }, 2000);
    }
  } else {
    await ctx.deleteMessage();
    const msg = await ctx.reply('Ты врёшь не тем СИЛАМ, шакалина!');
    setTimeout(() => {
      bot.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
      bot.telegram.sendMessage(chatId, 'Сосал???').then(sosMsg => {
        setTimeout(() => bot.telegram.deleteMessage(chatId, sosMsg.message_id).catch(() => {}), 2000);
      });
    }, 2000);
  }
});

// Обработка ввода формулы
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  const state = userStates[userId]?.state;

  if (state === 'awaiting_dice_formula' || state === 'awaiting_single_dice') {
    if (chatId < 0 && !(await db.collection('masters').findOne({ groupId: chatId.toString(), isActive: true }))) {
      await ctx.reply('Нет активного Мастера! Подтверди силу Мастера через /start.');
      return;
    }
    const formula = ctx.message.text.trim().toLowerCase();
    const result = rollDice(formula);
    if (result) {
      const response = formatResult(formula, result);
      await ctx.reply(`${username} кинул ${formula}: ${response}`);
      if (chatId < 0) {
        const masters = await db.collection('masters').find({ groupId: chatId.toString(), isActive: true }).toArray();
        for (const master of masters) {
          const time = moment().tz('Europe/Moscow').format('HH:mm');
          await bot.telegram.sendMessage(master.userId, `${time} ${username} кинул ${formula}: ${response}`);
        }
      }
    } else {
      await ctx.reply('Неверная формула! Пример: 2d6+1d8, 4f');
    }
    delete userStates[userId];
    await ctx.reply('Выбери режим:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'nDx+!+F/Судьба', callback_data: 'dice_mode' }],
          [{ text: '1Dx/Судьба', callback_data: 'single_dice_mode' }]
        ]
      }
    });
  } else if (state === 'awaiting_check' && await isMaster(userId, chatId.toString())) {
    const [formula, dc] = ctx.message.text.trim().toLowerCase().split(/\s+/);
    const result = rollDice(formula);
    if (result && dc && !isNaN(dc)) {
      await ctx.reply(formatCheck(formula, parseInt(dc), result));
    } else {
      await ctx.reply('Неверный формат! Пример: 1d20+5 15');
    }
    delete userStates[userId];
  } else if (state === 'awaiting_fate_check' && await isMaster(userId, chatId.toString())) {
    const dc = parseInt(ctx.message.text.trim());
    if (!isNaN(dc)) {
      const result = rollDice('4f');
      await ctx.reply(formatFateCheck(dc, result));
    } else {
      await ctx.reply('Неверный DC! Пример: 2');
    }
    delete userStates[userId];
  } else if (ctx.message.text.startsWith('/master')) {
    const code = ctx.message.text.split(' ')[1];
    if (!code) {
      await ctx.reply('Введи код: /master <код>');
      return;
    }
    const invite = await db.collection('invites').findOne({ code, used: false, expiresAt: { $gt: Date.now() } });
    if (invite) {
      userStates[userId] = { state: 'awaiting_group_confirmation', inviteCode: code };
      await ctx.reply('Скрижали не врали! Подтверди силу Мастера в чате с бомжами-убивцами после /start...');
      setTimeout(() => delete userStates[userId], 10 * 60 * 1000); // 10 минут тайм-аут
    } else {
      await ctx.reply('Неверный или использованный код');
    }
  } else if (ctx.message.text === '/add_master' && chatId < 0) {
    if (await db.collection('masters').findOne({ userId: userId.toString() })) {
      userStates[userId] = { state: 'awaiting_group_confirmation', inviteCode: 'reuse' };
      await ctx.reply('Подтверди силу Мастера!', {
        reply_markup: {
          inline_keyboard: [[{ text: 'Подтверди силу Мастера!', callback_data: 'confirm_master' }]]
        }
      });
      setTimeout(() => delete userStates[userId], 10 * 60 * 1000); // 10 минут тайм-аут
    } else {
      await ctx.reply('Ты не Мастер! Зарегистрируйся через /master <код>.');
    }
  }
});

// Запуск бота
connectToMongo().then(() => {
  bot.launch();
  console.log('Bot started');
}).catch(err => console.error('MongoDB connection error:', err));
