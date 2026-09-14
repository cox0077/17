const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    let filePath;

    if (req.url === "/") {
        filePath = path.join(__dirname, "17.html");
    } else {
        filePath = path.join(__dirname, req.url);
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }

        let contentType = "text/html";

        if (filePath.endsWith(".js")) {
            contentType = "text/javascript";
        }

        if (filePath.endsWith(".css")) {
            contentType = "text/css";
        }

        res.writeHead(200, {
            "Content-Type": contentType
        });

        res.end(data);
    });
});


const wss = new WebSocket.Server({
    server
});


const users = new Map();


wss.on("connection", (socket) => {

    console.log("Новое подключение");


    socket.on("message", (data) => {

        let message;

        try {
            message = JSON.parse(data.toString());
        } catch {
            return;
        }


        /*
         * Пользователь подключился
         */

        if (message.type === "login") {

            const username =
                String(message.username || "Гость")
                .substring(0, 30);

            users.set(socket, username);

            broadcast({
                type: "system",
                text: username + " подключился"
            });

            broadcastUsers();

            return;
        }


        /*
         * Сообщение
         */

        if (message.type === "message") {

            const username =
                users.get(socket) || "Гость";

            const text =
                String(message.text || "")
                .trim()
                .substring(0, 2000);

            if (!text) {
                return;
            }


            broadcast({

                type: "message",

                username,

                text,

                time:
                    new Date().toLocaleTimeString(
                        "ru-RU",
                        {
                            hour: "2-digit",
                            minute: "2-digit"
                        }
                    )

            });

        }

    });


    socket.on("close", () => {

        const username =
            users.get(socket);

        users.delete(socket);

        if (username) {

            broadcast({
                type: "system",
                text: username + " отключился"
            });

        }

        broadcastUsers();

    });

});


function broadcast(data) {

    const text =
        JSON.stringify(data);

    for (const client of wss.clients) {

        if (
            client.readyState ===
            WebSocket.OPEN
        ) {

            client.send(text);

        }

    }

}


function broadcastUsers() {

    const list =
        Array.from(users.values());

    broadcast({
        type: "users",
        users: list
    });

}


server.listen(PORT, "0.0.0.0", () => {

    console.log("");
    console.log("==============================");
    console.log("       17 MESSENGER");
    console.log("==============================");
    console.log("");
    console.log(
        "Сервер запущен:"
    );
    console.log(
        "http://localhost:" + PORT
    );
    console.log("");

});