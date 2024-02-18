import { BackpackClient } from "./api_client";
import * as dotenv from "dotenv";
import { delay } from "./helper";
import _ from "lodash"
import { DELAY_MAX, DELAY_MIN, TRADE_TOKEN } from "./config";
dotenv.config();

function getNowFormatDate(): string {
    const date: Date = new Date();
    const seperator1: string = "-";
    const seperator2: string = ":";
    let month: string | number = date.getMonth() + 1;
    let strDate: string | number = date.getDate();
    let strHour: string | number = date.getHours();
    let strMinute: string | number = date.getMinutes();
    let strSecond: string | number = date.getSeconds();

    if (month >= 1 && month <= 9) {
        month = "0" + month;
    }
    if (strDate >= 0 && strDate <= 9) {
        strDate = "0" + strDate;
    }
    if (strHour >= 0 && strHour <= 9) {
        strHour = "0" + strHour;
    }
    if (strMinute >= 0 && strMinute <= 9) {
        strMinute = "0" + strMinute;
    }
    if (strSecond >= 0 && strSecond <= 9) {
        strSecond = "0" + strSecond;
    }

    const currentdate: string = date.getFullYear() + seperator1 + month + seperator1 + strDate
        + " " + strHour + seperator2 + strMinute
        + seperator2 + strSecond;

    return currentdate;
}

let successbuy: number = 0;
let sellbuy: number = 0;

const init = async (client: BackpackClient): Promise<void> => {
    const randomDelay = _.random(DELAY_MIN, DELAY_MAX)
    try {
        console.log("\n============================");
        console.log(`Total Buy: ${successbuy} | Total Sell: ${sellbuy}`);
        console.log("============================\n");

        console.log(getNowFormatDate(), `Waiting ${randomDelay / 1000} seconds...`);
        const token = _.sample(TRADE_TOKEN) as string
        await delay(randomDelay);
        console.log(`Picked Token $${token}`)
        const pair = `${token}_USDC`
        let userbalance = await client.Balance();
        if (getTokenBalance(userbalance, "USDC") > 5) {
            await buyfun(client, pair, token);
        } else {
            await sellfun(client, pair, token);
            return;
        }
    } catch (e) {
        console.log(getNowFormatDate(), `Try again... (${(e as any).message})`);
        console.log("=======================");

        await delay(3000);
        init(client);
    }
};

const sellfun = async (client: BackpackClient, pair_trade: string, token: string): Promise<void> => {
    let GetOpenOrders = await client.GetOpenOrders({ symbol: pair_trade });
    if (GetOpenOrders.length > 0) {
        await client.CancelOpenOrders({ symbol: pair_trade });
        console.log(getNowFormatDate(), "All pending orders canceled");
    }

    let userbalance = await client.Balance();
    
    console.log(getNowFormatDate(), `My Account Infos: ${getTokenBalance(userbalance, token)} $${token} | ${getTokenBalance(userbalance, 'USDC')} $USDC`);

    let { lastPrice: lastPriceask } = await client.Ticker({ symbol: pair_trade });
    console.log(getNowFormatDate(), "Price pair_trade:", lastPriceask);
    let quantitys = ((getTokenBalance(userbalance, token) / 2) - 0.02).toFixed(2).toString();
    if (Number(quantitys) <= 0) {
        return
    }
    console.log(getNowFormatDate(), `Trade... ${quantitys} $${token} to ${(lastPriceask * Number(quantitys)).toFixed(2)} $USDC`);
    let orderResultAsk = await client.ExecuteOrder({
        orderType: "Limit",
        price: lastPriceask.toString(),
        quantity: quantitys,
        side: "Ask",
        symbol: pair_trade,
        timeInForce: "IOC"
    });

    if (orderResultAsk?.status == "Filled" && orderResultAsk?.side == "Ask") {
        sellbuy += 1;
        console.log(getNowFormatDate(), "Sold successfully:", `Order number:${orderResultAsk.id}`);
        init(client);
    } else {
        if (orderResultAsk?.status == 'Expired') {
            throw new Error("Sell Order Expired");
        } else {
            throw new Error(orderResultAsk?.status);
        }
    }
};

const buyfun = async (client: BackpackClient, pair_trade: string, token: string): Promise<void> => {
    let GetOpenOrders = await client.GetOpenOrders({ symbol: pair_trade });
    if (GetOpenOrders.length > 0) {
        await client.CancelOpenOrders({ symbol: pair_trade });
        console.log(getNowFormatDate(), "All pending orders canceled");
    }

    let userbalance = await client.Balance();
    console.log(getNowFormatDate(), `My Account Infos: ${getTokenBalance(userbalance, token)} ${token} | ${getTokenBalance(userbalance, 'USDC')} $USDC`);

    let { lastPrice } = await client.Ticker({ symbol: pair_trade });
    console.log(getNowFormatDate(), "Price of pair_trade:", lastPrice);
    let quantitys = ((getTokenBalance(userbalance, 'USDC') - 2) / lastPrice).toFixed(2).toString();
    if (Number(quantitys) <= 0) {
        return
    }
    console.log(getNowFormatDate(), `Trade ... ${(userbalance.USDC.available - 2).toFixed(2).toString()} $USDC to ${quantitys} $${token}`);
    let orderResultBid = await client.ExecuteOrder({
        orderType: "Limit",
        price: lastPrice.toString(),
        quantity: quantitys,
        side: "Bid",
        symbol: pair_trade,
        timeInForce: "IOC"
    });

    if (orderResultBid?.status == "Filled" && orderResultBid?.side == "Bid") {
        successbuy += 1;
        console.log(getNowFormatDate(), "Bought successfully:", `Order number: ${orderResultBid.id}`);
        init(client);
    } else {
        if (orderResultBid?.status == 'Expired') {
            throw new Error("Buy Order Expired");
        } else {
            throw new Error(orderResultBid?.status);
        }
    }
};
function getTokenBalance(userbalance: any, token: string): number {
    if (token in userbalance) {
        return userbalance[`${token}`].available
    } else {
        return 0
    }
}

(async () => {
    const apisecret: string = process.env["API_SECRET"] as string;
    const apikey: string = process.env["API_KEY"] as string;
    const client: BackpackClient = new BackpackClient(apisecret, apikey);
    init(client);
})();
