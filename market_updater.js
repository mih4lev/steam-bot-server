const fetch = require('node-fetch');
const request = require('request');
const cheerio = require('cheerio');

const { DB } = require("./db");

const insertItems = async () => {
    try {
        const itemsResponse = await fetch(`https://api.steamapis.com/market/items/730?api_key=ZcZOuD6ai2QvTfcBbwBhC3u6et0`);
        const items = await itemsResponse.json();
        console.log(items.data.length);
        const itemsArrays = [];
        for (let i = 0; i <= items.data.length / 1000; i++) {
            itemsArrays.push(items.data.slice(i * 1000, i * 1000 + 1000));
        };
        for (const slicedArray of itemsArrays) {
            const promises = slicedArray.map((item) => {
                const { 
                    nameID, market_name, market_hash_name, border_color, image, 
                    prices: { 
                        latest: price_latest, min: price_min, max: price_max, 
                        sold: { last_24h: sold_24h, last_7d: sold_7d, last_30d: sold_30d },
                        first_seen
                    }, 
                    updated_at
                } = item;
                if (!nameID || !market_name) return false;
                const itemData = { 
                    assetid: nameID, market_name, market_hash_name, border_color, image, 
                    price_latest, price_min, price_max, sold_24h, sold_7d, sold_30d, 
                    first_seen, updated_at
                };
                return new Promise(async (resolve) => {
                    const query = `INSERT INTO market_items SET ?`;
                    const response = await DB(query, itemData);
                    const status = Number(response.affectedRows && response.affectedRows === 1);
                    resolve(status);
                });
            });
            const status = await Promise.all(promises);
            console.log(status);
        }
        return { status: `done` };
    } catch (error) {
        return { status: 0, error };
    }
};

const requestItemInfo = async (market_hash_name) => {
    return new Promise ((resolve) => {
        try {
            const link = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(market_hash_name)}/render/?query=&start=0&count=10&country=RU&language=russian&currency=5`;
            request(link, (error, response, body) => {
                try {
                    const data = JSON.parse(body);
                    let item_type_ru;
                    if (data.assets && data.assets['730'] && data.assets['730']['2']) {
                        for (const asset in data.assets['730']['2']) {
                            item_type_ru = data.assets['730']['2'][asset].type;
                        }
                    }
                    var $ = cheerio.load(data.results_html);
                    // itemName
                    const match = $(".market_listing_item_name");
                    const itemName = match.html();
                    // lowestPrice
                    let lowestPrice;
                    const matchPrice = $(".market_listing_price.market_listing_price_with_fee");
                    if (matchPrice) {
                        for (var i = 0; i < matchPrice.length; i++) {
                            lowestPrice = parseFloat($(matchPrice[i]).text().replace(",", ".").replace(/[^\d.]/g, ''));
                            if (!isNaN(lowestPrice)) break;
                        }
                    }
                    resolve({ fullname_ru: itemName, price_ru: lowestPrice, item_type_ru });
                } catch (error) {
                    console.log(error);
                    resolve({});
                }
            });
        } catch (error) {
            resolve({});
            console.log(error);
        }
    });
};

const typesMap = {
    'Ширпотреб': `common`,
    'Промышленное качество': `uncommon`,
    'Армейское качество': `rare`,
    'Запрещённое': `mythical`,
    'Засекреченное': `legendary`,
    'Тайное': `ancient`,
    'экстраординарного типа': `extraordinary`
};

const weaponGroupMap = {
    1: [`Пистолет`],
    2: [`Пистолет-пулемёт`],
    3: [`Винтовка`, `Снайперская винтовка`],
    4: [`Дробовик`, `Пулемёт`],
    5: [`Нож`],
    6: [`Перчатки`]
};

const rarityNumsMap = {
    1: { prop: `rare` },
    2: { prop: `mythical` },
    3: { prop: `ancient` },
    5: { prop: `legendary` }
}

const requestDetails = (item_type_ru) => {
    const strange = item_type_ru.includes(`StatTrak™`);
    const unusual = item_type_ru.includes(`★`);
    const tournament = item_type_ru.includes(`Сувенирный`);
    let rarity, group, rarity_num;
    for (const rarityName in typesMap) {
        if (item_type_ru.includes(rarityName)) {
            rarity = typesMap[rarityName];
        }
    }
    for (const groupName in weaponGroupMap) {
        weaponGroupMap[groupName].forEach((itemName) => {
            if (item_type_ru.includes(itemName)) {
                group = Number(groupName);
            }
        });
    }
    for (const rarityName in rarityNumsMap) {
        if (rarity === rarityNumsMap[rarityName].prop) {
            rarity_num = Number(rarityName);
        } 
    }
    if (group === 5 || group === 6) rarity_num = 4;
    return { strange, unusual, tournament, rarity, group, rarity_num };
};

const exteriorMap = {
    'Прямо с завода': 0,
    'Немного поношенное': 1,
    'После полевых испытаний': 2,
    'Поношенное': 3,
    'Закалённое в боях': 4
};

const mainDetails = (fullname_ru) => {
    const nameSplit = fullname_ru.indexOf(`| `) - 1;
    let name_ru = (nameSplit > 0) ? fullname_ru.substr(0, nameSplit) : fullname_ru;
    if (name_ru.indexOf(`★`) >= 0) name_ru = name_ru.substr(name_ru.indexOf(`★`) + 2);
    if (name_ru.indexOf(`StatTrak™`) >= 0) name_ru = name_ru.substr(name_ru.indexOf(`StatTrak™`) + 10);
    if (name_ru.indexOf(`Сувенирный`) >= 0) name_ru = name_ru.substr(name_ru.indexOf(`Сувенирный`) + 11);
    // skin_ru
    let skin_ru;
    if (fullname_ru.indexOf(`| `) > 0) {
        const skinSplitFrom = fullname_ru.indexOf(`| `) + 2;
        const skinExteriorSplit = fullname_ru.indexOf(`(`);
        const skinSplitTo = skinExteriorSplit - skinSplitFrom - 1;
        skin_ru = (skinExteriorSplit > 0) ? fullname_ru.substr(skinSplitFrom, skinSplitTo) : fullname_ru.substr(skinSplitFrom);
    }
    // exterior_ru
    let exterior_ru;
    if (fullname_ru.indexOf(`(`) > 0 && fullname_ru.indexOf(`)`) > 0) {
        const exteriorSplitFrom = fullname_ru.indexOf(`(`) + 1;
        const exteriorSplitTo = fullname_ru.indexOf(`)`) - fullname_ru.indexOf(`(`) - 1;
        exterior_ru = fullname_ru.substr(exteriorSplitFrom, exteriorSplitTo);
    }
    let exterior_num;
    if (exterior_ru) {
        exterior_num = exteriorMap[exterior_ru];
    }
    return { name_ru, skin_ru, exterior_ru, exterior_num };
};

const updateItem = async ({ assetid, ...incomeData }) => {
    try {
        const { fullname_ru, price_ru, item_type_ru, steam_update } = incomeData;
        const detailed = requestDetails(item_type_ru);
        const details = mainDetails(fullname_ru);
        let updateData = { fullname_ru, steam_update, ...detailed, ...details };
        updateData = (incomeData.price_ru && !isNaN(incomeData.price_ru)) ? { ...updateData, price_ru } : { ...updateData };
        updateData = (item_type_ru) ? { ...updateData, item_type_ru } : { ...updateData };
        console.log(updateData);
        const query = `UPDATE market_items SET ? WHERE assetid = ?`;
        const response = await DB(query, [ updateData, assetid ]);
        const status = Number(response.affectedRows && response.affectedRows === 1);
        return { status, requestID: Number(assetid) };
    } catch (error) {
        console.log(error);
        return { status: 0, error };
    }
};

// const shuffle = (array) => {
//     array.sort(() => Math.random() - 0.5);
// }

const updateItemsData = async () => {
    const items = await DB(`SELECT * FROM market_items ORDER BY steam_update ASC`);
    for (const item of items) {
        if (
            item.market_name.includes(`Case`) || 
            item.market_name.includes(`Graffiti`) || 
            item.market_name.includes(`Sticker`) || 
            item.market_name.includes(`Operation`) ||
            item.market_name.includes(`Package`) ||
            item.market_name.includes(`Pin`) ||
            item.market_name.includes(`Music Kit`) ||
            item.market_name.includes(`Patch`) ||
            item.market_name.includes(`Challengers`) ||
            item.market_name.includes(`Capsule`)
        ) continue;
        const timeout = Math.round(7500 + (Math.random() * 5000));
        await new Promise((resolve) => setTimeout(() => { resolve() }, timeout));
        const data = await requestItemInfo(item.market_hash_name);
        if (!data.fullname_ru) continue;
        const steam_update = Math.round((new Date()) / 1000);
        const updateData = { 
            assetid: item.assetid, fullname_ru: data.fullname_ru, 
            price_ru: data.price_ru, item_type_ru: data.item_type_ru, steam_update
        };
        await updateItem(updateData);
    }
    updateItemsData();
};

updateItemsData();