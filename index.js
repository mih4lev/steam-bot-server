// API
const EventEmitter = require('events');
const emitter = new EventEmitter();
const express = require(`express`);
const app = express();
const expressWS = require('express-ws')(app);
app.use(express.json({ extended: true }));

// Add headers
app.use(function (request, response, next) {
	response.setHeader('Access-Control-Allow-Origin', 'http://localhost:8080');
	response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
	response.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
	response.setHeader('Access-Control-Allow-Credentials', true);
	next();
});

require('dotenv').config();

// STEAM
const SteamUser = require(`steam-user`);
const SteamCommunity = require(`steamcommunity`);
const TradeManager = require(`steam-tradeoffer-manager`);
const steamTOTP = require(`steam-totp`);

const steam = new SteamUser();

const steamOptions = { 
	accountName: process.env.STEAM_ACCOUNT, 
	password: process.env.STEAM_PASSWORD, 
	twoFactorCode: steamTOTP.getAuthCode(process.env.STEAM_SHARED_SECRET)
};
const managerOptions = { steam, domain: `localhost`, language: `ru` };

const manager = new TradeManager(managerOptions);
const community = new SteamCommunity();

// misc func

const exitWithError = (error) => {
	console.log(error);
	process.exit(1);
};

// listeners

steam.on(`loggedOn`, () => {
	console.log(`Logged into Steam`);
});

steam.on(`webSession`, (sessionID, cookies) => {
	manager.setCookies(cookies, (error) => {
		if (error) exitWithError(error);
		console.log(`Got API key: ` + manager.apiKey);
	});
	community.setCookies(cookies);
});

manager.on(`newOffer`, (offer) => {
	console.log(`New offer #` + offer.id + ` from ` + offer.partner.getSteam3RenderedID());
	offer.accept((error, status) => {
		if (error) return exitWithError(error);
		console.log(`Offer accepted: ` + status);
		if (status !== `pending`) return false;
		community.acceptConfirmationForObject(process.env.STEAM_IDENTITY_SECRET, offer.id, (error) => {
			if (error) return exitWithError(error);
			console.log(`Trade offer ` + offer.id + ` confirmed`);
		});
	});
});

manager.on(`receivedOfferChanged`, (offer, oldState) => {
	console.log(`Offer #${offer.id} changed: ${TradeManager.ETradeOfferState[oldState]} -> ${TradeManager.ETradeOfferState[offer.state]}`);
	if (offer.state != TradeManager.ETradeOfferState.Accepted) return false;
	offer.getExchangeDetails((error, status, tradeInitTime, receivedItems, sentItems) => {
		if (error) return exitWithError(error);
		const newReceivedItems = receivedItems.map(item => item.new_assetid);
		const newSentItems = sentItems.map(item => item.new_assetid);
		console.log(`Received items ${newReceivedItems.join(',')} Sent Items ${newSentItems.join(',')} - status ${TradeManager.ETradeStatus[status]}`)
	});
});

/*
	Invalid: 1,
	Active: 2 - This trade offer has been sent, neither party has acted on it yet.
	Accepted: 3 - The trade offer was accepted by the recipient and items were exchanged.
	Countered: 4 - The recipient made a counter offer
	Expired: 5 - The trade offer was not accepted before the expiration date
	Canceled: 6 - The sender cancelled the offer
	Declined: 7 - The recipient declined the offer
	InvalidItems: 8 - Some of the items in the offer are no longer available (indicated by the missing flag in the output)
	CreatedNeedsConfirmation: 9 - The offer hasn't been sent yet and is awaiting further confirmation
	CanceledBySecondFactor: 10 - Either party canceled the offer via email/mobile confirmation
	InEscrow: 11 - The trade has been placed on hold
*/
manager.on(`sentOfferChanged`, (offer) => {
	const items = offer.itemsToReceive.map((itemData) => formatItemData({ itemData }));
	const data = { state: offer.state, items };
	emitter.emit(`socketMessage`, JSON.stringify(data));
	if (offer.state !== 3) offer.decline();
});

manager.on(`sentOfferCanceled`, (offer, reason) => {
	console.log(`sentOfferCanceled`);
});

manager.on(`sentPendingOfferCanceled`, (offer) => {
	console.log(`sentPendingOfferCanceled`);
});

manager.on(`realTimeTradeConfirmationRequired`, (offer) => {
	console.log(`realTimeTradeConfirmationRequired`);
});

manager.on(`realTimeTradeCompleted`, (offer) => {
	console.log(`realTimeTradeCompleted`);
});

steam.on(`newItems`, (count) => {
	console.log(`newItems`, count);
});

// steam login

setTimeout(() => {
	steam.logOn(steamOptions);
}, 10000);

// misc functions

const formatItemData = ({ itemData, priceData }) => {
	const price = (priceData) ? priceData.lowestPrice / 100 : null;
	const { 
		assetid, name, name_color, type, market_name, market_hash_name, 
		marketable, tags, icon_url, icon_url_large
	} = itemData;
	return {
		assetid, name, name_color, type, market_name, market_hash_name, 
		marketable, tags, price,
		icons: { 
			thumb: `http://cdn.steamcommunity.com/economy/image/` + icon_url,
			image: `http://cdn.steamcommunity.com/economy/image/` + icon_url_large,
		}
	};
};

// api functions

const requestInventory = ({ steamID }) => {
	return new Promise((resolve) => {
		community.getUserInventoryContents(steamID, 730, 2, true, `russian`, (error, inventory) => {
			if (error) return resolve(error);
			const items = inventory.map((itemData) => formatItemData({ itemData }));
			resolve(items);
		});
	});
};

const requestInventoryWithPrice = ({ steamID }) => {
	return new Promise((resolve) => {
		community.getUserInventoryContents(steamID, 730, 2, true, `russian`, (error, inventory) => {
			if (error) return resolve(error);
			const itemPromises = inventory.map((itemData) => {
				const { market_hash_name } = itemData;
				return new Promise((resolve) => {
					community.getMarketItem(730, market_hash_name, (error, priceData) => {
						if (error) resolve([]);
						resolve(priceData);
					});
				}).then((priceData) => formatItemData({ itemData, priceData }));
			});
			Promise.all(itemPromises).then((result) => resolve(result));
		});
	});
};

const requestItemPrice = ({ marketName }) => {
	return new Promise((resolve) => {
		community.getMarketItem(730, marketName, (error, item) => {
			if (error) resolve(error);
			const { lowestPrice } = item;
			resolve({ price: lowestPrice / 100 });
		});
	});
};

const createSellOffer = ({ steamID, items }) => {
	return new Promise((resolve) => {
		const offer = manager.createOffer(steamID);
		offer.loadPartnerInventory(730, 2, (error, inventory) => {
			if (error) resolve(error);
			inventory.forEach((item) => {
				if (!items.includes(item.assetid)) return false;
				offer.addTheirItem(item);
			});
			offer.send((error, status) => {
				if (error) resolve(error);
				resolve(status);
			});
		});
	});
};

// EXPRESS

// http://localhost:8888/api/inventory/76561198055031516
app.get(`/api/inventory/:steamID`, async (request, response) => {
	const { params: { steamID }} = request;
	// const steamID = `https://steamcommunity.com/tradeoffer/new/?partner=94765788&token=Xkh5V4FQ`;
	const data = await requestInventory({ steamID });
	response.json(data);
});

// http://localhost:8888/api/inventory/76561198055031516/price
app.get(`/api/inventory/:steamID/price`, async (request, response) => {
	const { params: { steamID }} = request;
	const data = await requestInventoryWithPrice({ steamID });
	response.json(data);
});

// http://localhost:8888/api/item/Galil%20AR%20%7C%20Signal%20(Field-Tested)/price
app.get(`/api/item/:marketName/price`, async (request, response) => {
	const { params: { marketName }} = request;
	const data = await requestItemPrice({ marketName });
	response.json(data);
});

// http://localhost:8888/api/trade/sell/
// body - steamID (ID or Trade link) | items - array of items assetid
app.post(`/api/trade/sell`, express.json({type: '*/*'}), async (request, response) => {
	const { body: { steamID, items }} = request;
	const data = await createSellOffer({ steamID, items });
	response.json(data);
});

app.get(`/api/trade/buy`, async (request, response) => {

});

app.ws(`/api/messages`, (WS, request) => {
	emitter.on(`socketMessage`, (message) => {
		WS.send(message);
	});
});

// http://cdn.steamcommunity.com/economy/image/ + icon_url

app.listen(process.env.PORT);