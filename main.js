const { urlencoded, json } = require("express");

require("dotenv").config();
const Axios = require("axios").default;
const app = require("express")();
const http = require("http").Server(app);
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const cron = require('node-cron');

class JSONDatabase {
    constructor(path) {
        this.path = path;
        let raw = fs.readFileSync(path);
        this.db = JSON.parse(raw);
        let cmap = new Map(Object.entries(this.db.collections));
        this.collections = new Map();
        cmap.forEach((data, key) => {
            this.collections.set(key, new Collection(data, key, this))
        })
        this.interval = null;
        this.timeout = null;
    }
    collection(key) {
        let _collection = this.collections.get(key);
        if (!_collection) {
            this.collections.set(key, new Collection({}, key, this));
            _collection = this.collections.get(key);
        }
        return _collection;
    }
    drop(key) {
        if (this.collections.get(key)) {
            this.collections.delete(key);
        }
    }
    sync() {
        let data = {};
        this.collections.forEach(col => {
            data[col.key] = Object.fromEntries(col.data);
        })
        this.db.collections = {...data};
        fsp.writeFile(this.path,JSON.stringify(this.db)).then(()=>{
        })
    }
    notifyChanges() {
        if (!this.interval) {
            this.interval = setInterval(()=>{
                this.sync();
            },500)
        }
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = setTimeout(()=>{
            clearInterval(this.interval);
            this.interval = null;
        },600)
    }
}


class Collection {
    constructor(data, key, db) {
        this.data = new Map(Object.entries(data));
        this.key = key;
        this.db = db;
    }
    generateObjectId = (m = Math, d = Date, h = 16, s = s => m.floor(s).toString(h)) =>
        s(d.now() / 1000) + ' '.repeat(h).replace(/./g, () => s(m.random() * h))

    findById(id) {
        let data = this.data.get(id);
        if (data) {
            return {_id: id, ...data};
        } else {
            return null;
        }
    }
    getAll() {
        let res = [];
        this.data.forEach((data, id) => {
            res.push({_id: id,...data});
        })
        return res;
    }
    upsert(id,data) {
        let obj = this.data.get(id);
        if (obj) {
            for (let key in data) {
                obj[key] = data[key];
            }
            this.db.notifyChanges();
            return {_id: id,...obj};
        } else {
            if (id === null) {
                let objectId = this.generateObjectId();
                this.data.set(objectId, data);
                this.db.notifyChanges();
                return {...this.data.get(objectId)}
            } else {
                return null
            }
        }
    }
    delete(id) {
        let data = this.data.get(id);
        if (data) {
            this.data.delete(id);
            return {_id: id, ...data};
        } else {
            return null;
        }
    }
}

const doGoogleSearch = async (query, start, apikey, cx) => {
    let resp = await Axios.get(process.env.PSE_APIURL, {
        params: {
            key: apikey,
            cx: cx,
            q: query,
            gl: process.env.PSE_GL,
            hl: process.env.PSE_GL,
            start: start
        }
    })
    return resp.data;
}

const getResults = async (queries, num=100) => {
    let resMap = new Map();
    let keys = db.collection("apikeys").getAll();
    let key = keys.find(k => k.quotas > 0);
    if (!key) return [];
    for (let qi = 0; qi < queries.length; qi++) {
        let query = queries[qi];
        let i = 1;
        let count = num;
        while (count > 0) {
            if (key.quotas <= 0) {
                key.quotas = 0;
                db.collection("apikeys").upsert(key._id, key);
                key = keys.find(k => k.quotas > 0);
                if (!key) {
                    break;
                }
            }
            try {
                let payload = await doGoogleSearch(query, i, key.apikey, key.cx);
                key.quotas -= 1;
                db.collection("apikeys").upsert(key._id, key);
                let results = [];
                if (payload.items) {
                    results = payload.items.map(data => {
                        return {
                            url: data.link,
                            title: data.title,
                            canonical: data.displayLink
                        }
                    })
                    if (payload.items.length < 10) {
                        break;
                    }
                } else {
                    break;
                }
                results.forEach(result => {
                    if (!resMap.get(result.canonical)) {
                        resMap.set(result.canonical, result);
                    }
                })

                if (count - 10 > 0) {
                    count -= 10;
                    i+=10;
                } else {
                    i+=count;
                    count = 0;
                }
            } catch (err) {
                key.quotas = 0;
                db.collection("apikeys").upsert(key._id, key);
                console.log("Quotas error:", err);
                key = keys.find(k => k.quotas > 0);
            }
        }
    }
    return Array.from(resMap.values());
}

app.use(cors());
app.use(urlencoded({extended: true}));
app.use(json());

const db = new JSONDatabase("db.json");

app.get("/search", async (req, res) => {
    try {
        let queries = req.query.keyword??[];
        let count = req.query.count??100;
        if (!Array.isArray(queries)) queries = [queries];
        console.log("Search: ",queries);
        let results = await getResults(queries,count);
        return res.status(200).json(results);
    } catch (err) {
        console.log("Error: ", err);
        return res.status(500).json({
            msg: "Internal server error!",
            trace: err
        })
    }
})

app.get("/apikeys", (req, res) => {
    try {
        let data = db.collection("apikeys").getAll();
        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({
            msg: "Internal server error!",
            trace: err
        })
    }
})

app.post("/apikey", (req, res) => {
    try {
        let payload = {};
        if (!req.body["cx"]||!req.body["apikey"])
            return res.status(400).json({
                msg: "Bad request"
            })
        payload.cx = req.body["cx"];
        payload.apikey = req.body["apikey"];
        payload.lastReset = Date.now();
        payload.quotas = 100;
        let data = db.collection("apikeys").upsert(null, payload);
        return res.status(200).json(data);
    } catch (err) {
        console.log("Error: ", err);
        return res.status(500).json({
            msg: "Internal server error!",
            trace: err
        })
    }
})
app.delete("/apikey", (req, res) => {
    try {
        let id = req.query.id;
        if (!id) return res.status(400).json({
            msg: "Bad request"
        })
        let data = db.collection("apikeys").delete(id);
        if (!data) return res.status(404).json({
            msg: "Not found"
        })
        return res.status(200).json(data);
    } catch (err) {
        console.log("Error: ", err);
        return res.status(500).json({
            msg: "Internal server error!",
            trace: err
        })
    }
})

http.listen(process.env.PORT, ()=>{
    console.log("Listening on port:",process.env.PORT);
})

cron.schedule('0 0 7 * * * *', () => {
    let apikeys = db.collection("apikeys").getAll();
    apikeys.forEach(apikey => {
        apikey.quotas = 100;
        apikey.lastReset = Date.now();
        db.col("apikeys").upsert(apikey._id, apikey);
    })
    console.log('Daily quotas reset');
}, {
    scheduled: true,
    timezone: "UTC"
  });