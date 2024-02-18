import axios from "axios";
import crypto from "crypto";
import qs from "qs";
import WebSocket from "ws";

const BACKOFF_EXPONENT = 1.5;
const DEFAULT_TIMEOUT_MS = 5000;
const BASE_URL = "https://api.backpack.exchange/";
interface Instruction {
    url: string;
    method: string;
}

const instructions: { public: Map<string, Instruction>, private: Map<string, Instruction> } = {
    public: new Map([
        ["assets", { url: `${BASE_URL}api/v1/assets`, method: "GET" }],
        ["markets", { url: `${BASE_URL}api/v1/markets`, method: "GET" }],
        ["ticker", { url: `${BASE_URL}api/v1/ticker`, method: "GET" }],
        ["depth", { url: `${BASE_URL}api/v1/depth`, method: "GET" }],
        ["klines", { url: `${BASE_URL}api/v1/klines`, method: "GET" }],
        ["status", { url: `${BASE_URL}api/v1/status`, method: "GET" }],
        ["ping", { url: `${BASE_URL}api/v1/ping`, method: "GET" }],
        ["time", { url: `${BASE_URL}api/v1/time`, method: "GET" }],
        ["trades", { url: `${BASE_URL}api/v1/trades`, method: "GET" }],
        ["tradesHistory", { url: `${BASE_URL}api/v1/trades/history`, method: "GET" }],
    ]),
    private: new Map([
        ["balanceQuery", { url: `${BASE_URL}api/v1/capital`, method: "GET" }],
        ["depositAddressQuery", { url: `${BASE_URL}wapi/v1/capital/deposit/address`, method: "GET" }],
        ["depositQueryAll", { url: `${BASE_URL}wapi/v1/capital/deposits`, method: "GET" }],
        ["fillHistoryQueryAll", { url: `${BASE_URL}wapi/v1/history/fills`, method: "GET" }],
        ["orderCancel", { url: `${BASE_URL}api/v1/order`, method: "DELETE" }],
        ["orderCancelAll", { url: `${BASE_URL}api/v1/orders`, method: "DELETE" }],
        ["orderExecute", { url: `${BASE_URL}api/v1/order`, method: "POST" }],
        ["orderHistoryQueryAll", { url: `${BASE_URL}wapi/v1/history/orders`, method: "GET" }],
        ["orderQuery", { url: `${BASE_URL}api/v1/order`, method: "GET" }],
        ["orderQueryAll", { url: `${BASE_URL}api/v1/orders`, method: "GET" }],
        ["withdraw", { url: `${BASE_URL}wapi/v1/capital/withdrawals`, method: "POST" }],
        ["withdrawalQueryAll", { url: `${BASE_URL}wapi/v1/capital/withdrawals`, method: "GET" }],
    ]),
};

const toPkcs8der = (rawB64: string): crypto.KeyObject => {
    const rawPrivate = Buffer.from(rawB64, "base64").subarray(0, 32);
    const prefixPrivateEd25519 = Buffer.from("302e020100300506032b657004220420", "hex");
    const der = Buffer.concat([prefixPrivateEd25519, rawPrivate]);
    return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
};

const toSpki = (rawB64: string): crypto.KeyObject => {
    const rawPublic = Buffer.from(rawB64, "base64");
    const prefixPublicEd25519 = Buffer.from("302a300506032b6570032100", "hex");
    const der = Buffer.concat([prefixPublicEd25519, rawPublic]);
    return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
};

const getMessageSignature = (request: any, privateKey: string, timestamp: number, instruction: string, window?: number): string => {
    const alphabeticalSort = (a: string, b: string) => {
        return a.localeCompare(b);
    };
    const message = qs.stringify(request, { sort: alphabeticalSort });
    const headerInfo = { timestamp, window: window ?? DEFAULT_TIMEOUT_MS };
    const headerMessage = qs.stringify(headerInfo);
    const messageToSign = "instruction=" +
        instruction +
        "&" +
        (message ? message + "&" : "") +
        headerMessage;
    const signature = crypto.sign(null, Buffer.from(messageToSign), toPkcs8der(privateKey));
    return signature.toString("base64");
};

const rawRequest = async (instruction: string, headers: any, data: any) => {
    const { url, method } = instructions.private.has(instruction)
        ? instructions.private.get(instruction)!
        : instructions.public.get(instruction)!;
    let fullUrl = url;
    headers["User-Agent"] = "Backpack API Client";
    headers["Content-Type"] =
        method == "GET"
            ? "application/x-www-form-urlencoded"
            : "application/json; charset=utf-8";
    const options: any = { headers };
    if (method == "GET") {
        fullUrl =
            url + (Object.keys(data).length > 0 ? "?" + qs.stringify(data) : "");
    }
    let config = (method == "POST" || method == "DELETE") ? {
        method: method,
        url: fullUrl,
        headers: headers,
        data: data
    } : {
        method: method,
        url: fullUrl,
        headers: headers,
    }
    const response = await axios.request(config);
    const contentType = response.headers["content-type"];
    if (contentType?.includes("application/json")) {
        const parsed = JSON.parse(JSON.stringify(response.data), function (_key: any, value: any) {
            if (value instanceof Array && value.length == 0) {
                return value;
            }
            if (isNaN(Number(value))) {
                return value;
            }
            return Number(value);
        });
        if (parsed.error && parsed.error.length) {
            const error = parsed.error
                .filter((e: string) => e.startsWith("E"))
                .map((e: string) => e.substr(1));
            if (!error.length) {
                throw new Error("Backpack API returned an unknown error");
            }
            throw new Error(`url=${url} body=${options["body"]} err=${error.join(", ")}`);
        }
        return parsed;
    }
    else if (contentType?.includes("text/plain")) {
        return response.data;
    }
    else {
        return response;
    }
};

class BackpackClient {
    private config: { privateKey: string, publicKey: string, timeout?: number };

    constructor(privateKey: string, publicKey: string) {
        this.config = { privateKey, publicKey };
        const pubkeyFromPrivateKey = crypto
            .createPublicKey(toPkcs8der(privateKey))
            .export({ format: "der", type: "spki" })
            .toString("base64");
        const pubkey = toSpki(publicKey)
            .export({ format: "der", type: "spki" })
            .toString("base64");
        if (pubkeyFromPrivateKey != pubkey) {
            throw new Error("Is the secret of the purchase price private and public?");
        }
    }

    async api(method: string, params?: any, retrysLeft = 10): Promise<any> {
        try {
            if (instructions.public.has(method)) {
                return await this.publicMethod(method, params);
            }
            else if (instructions.private.has(method)) {
                return await this.privateMethod(method, params);
            }
        }
        catch (e: any) {
            if (retrysLeft > 0) {
                const numTry = 11 - retrysLeft;
                const backOff = Math.pow(numTry, BACKOFF_EXPONENT);
                console.warn("BPX api error", {
                    method,
                    numTry,
                    backOff,
                }, e.toString(), e.response && e.response.body ? e.response.body : '');
                await new Promise((resolve) => setTimeout(resolve, backOff * 1000));
                return await this.api(method, params, retrysLeft - 1);
            }
            else {
                throw e;
            }
        }
        throw new Error(method + " is not a valid API method.");
    }

    async publicMethod(instruction: string, params = {}): Promise<any> {
        const response = await rawRequest(instruction, {}, params);
        return response;
    }

    async privateMethod(instruction: string, params = {}): Promise<any> {
        const timestamp = Date.now();
        const signature = getMessageSignature(params, this.config.privateKey, timestamp, instruction);
        const headers = {
            "X-Timestamp": timestamp,
            "X-Window": this.config.timeout ?? DEFAULT_TIMEOUT_MS,
            "X-API-Key": this.config.publicKey,
            "X-Signature": signature,
        };
        const response = await rawRequest(instruction, headers, params);
        return response;
    }

    async Balance(): Promise<any> {
        return this.api("balanceQuery");
    }

    async Deposits(params: any): Promise<any> {
        return this.api("depositQueryAll", params);
    }

    async DepositAddress(params: any): Promise<any> {
        return this.api("depositAddressQuery", params);
    }

    async Withdrawals(params: any): Promise<any> {
        return this.api("withdrawalQueryAll", params);
    }

    async Withdraw(params: any): Promise<void> {
        this.api("withdraw", params);
    }

    async OrderHistory(params: any): Promise<any> {
        return this.api("orderHistoryQueryAll", params);
    }

    async FillHistory(params: any): Promise<any> {
        return this.api("fillHistoryQueryAll", params);
    }

    // async Assets(): Promise<any> {
    //     return this.api("assets");
    // }

    // async Markets(): Promise<any> {
    //     return this.api("markets");
    // }

    async Ticker(params: any): Promise<any> {
        return this.api("ticker", params);
    }

    async Depth(params: any): Promise<any> {
        return this.api("depth", params);
    }

    async KLines(params: any): Promise<any> {
        return this.api("klines", params);
    }

    async GetOrder(params: any): Promise<any> {
        return this.api("orderQuery", params);
    }

    async ExecuteOrder(params: any): Promise<any> {
        return this.api("orderExecute", params, 3);
    }

    async CancelOrder(params: any): Promise<any> {
        return this.api("orderCancel", params);
    }

    async GetOpenOrders(params: any): Promise<any> {
        return this.api("orderQueryAll", params);
    }

    async CancelOpenOrders(params: any): Promise<any> {
        return this.api("orderCancelAll", params);
    }

    // async Status(): Promise<any> {
    //     return this.api("status");
    // }

    // async Ping(): Promise<any> {
    //     return this.api("ping");
    // }

    // async Time(): Promise<any> {
    //     return this.api("time");
    // }

    async RecentTrades(params: any): Promise<any> {
        return this.api("trades", params);
    }

    async HistoricalTrades(params: any): Promise<any> {
        return this.api("tradesHistory", params);
    }

    subscribeOrderUpdate(): WebSocket {
        const privateStream = new WebSocket('wss://ws.backpack.exchange');
        const timestamp = Date.now();
        const window = 5000;
        const signature = getMessageSignature({}, this.config.privateKey, timestamp, "subscribe", window);
        const subscriptionData = {
            method: 'SUBSCRIBE',
            params: ["account.orderUpdate"],
            "signature": [this.config.publicKey, signature, timestamp.toString(), window.toString()]
        };
        privateStream.onopen = (_: any) => {
            console.log('Connected to BPX Websocket');
            privateStream.send(JSON.stringify(subscriptionData));
        };
        privateStream.onerror = (error: any) => {
            console.log(`Websocket Error ${error}`);
        };
        return privateStream;
    }
}

export { BackpackClient };
