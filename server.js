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

        // Вход пользователя
        if (message.type === "login") {

            const username = String(
                message.username || "Гость"
            )
            .trim()
            .substring(0, 30);

            if (!username) {
                return;
            }

            users.set(socket, username);

            socket.send(JSON.stringify({
                type: "login_success",
                username: username
            }));

            broadcastUsers();

            console.log(
                username + " подключился"
            );

            return;
        }

        // Личное сообщение
        if (message.type === "private_message") {

            const sender = users.get(socket);

            if (!sender) {
                return;
            }

            const recipient = String(
                message.to || ""
            )
            .trim()
            .substring(0, 30);

            const text = String(
                message.text || ""
            )
            .trim()
            .substring(0, 2000);

            if (!recipient || !text) {
                return;
            }

            let recipientSocket = null;

            for (const [client, username] of users.entries()) {

                if (username === recipient) {
                    recipientSocket = client;
                    break;
                }
            }

            if (!recipientSocket) {

                socket.send(JSON.stringify({
                    type: "error",
                    text: "Пользователь не в сети"
                }));

                return;
            }

            const time = new Date().toLocaleTimeString(
                "ru-RU",
                {
                    hour: "2-digit",
                    minute: "2-digit"
                }
            );

            const privateMessage = {
                type: "private_message",
                from: sender,
                to: recipient,
                text: text,
                time: time
            };

            // Отправляем получателю
            recipientSocket.send(
                JSON.stringify(privateMessage)
            );

            // Отправляем копию отправителю
            socket.send(
                JSON.stringify(privateMessage)
            );

            return;
        }
    });

    socket.on("close", () => {

        const username = users.get(socket);

        users.delete(socket);

        if (username) {
            console.log(
                username + " отключился"
            );
        }

        broadcastUsers();
    });
});


function broadcastUsers() {

    const list = Array.from(
        users.values()
    );

    const data = JSON.stringify({
        type: "users",
        users: list
    });

    for (const client of wss.clients) {

        if (
            client.readyState ===
            WebSocket.OPEN
        ) {
            client.send(data);
        }
    }
}


server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log("");
        console.log("==============================");
        console.log("       17 MESSENGER");
        console.log("==============================");
        console.log("");
        console.log("Сервер запущен:");
        console.log(
            "http://localhost:" + PORT
        );
        console.log("");
    }
);
