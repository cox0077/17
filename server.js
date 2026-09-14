const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

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

const wss = new WebSocket.Server({ server });

const users = new Map();

function hashPassword(password, salt) {
    return crypto
        .pbkdf2Sync(password, salt, 100000, 64, "sha512")
        .toString("hex");
}

function createPasswordHash(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);

    return {
        salt,
        hash
    };
}

function checkPassword(password, salt, storedHash) {
    const hash = hashPassword(password, salt);

    return crypto.timingSafeEqual(
        Buffer.from(hash, "hex"),
        Buffer.from(storedHash, "hex")
    );
}

async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(30) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log("PostgreSQL database initialized");
}

async function sendUserList() {
    const result = await pool.query(`
        SELECT id, username
        FROM users
        ORDER BY username
    `);

    const onlineIds = new Set();

    for (const [socket, user] of users.entries()) {
        if (socket.readyState === WebSocket.OPEN) {
            onlineIds.add(user.id);
        }
    }

    const userList = result.rows.map(user => ({
        id: user.id,
        username: user.username,
        online: onlineIds.has(user.id)
    }));

    const data = JSON.stringify({
        type: "users",
        users: userList
    });

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    }
}

function sendError(socket, text) {
    socket.send(JSON.stringify({
        type: "error",
        text
    }));
}

wss.on("connection", socket => {
    console.log("Новое подключение");

    socket.on("message", async data => {
        let message;

        try {
            message = JSON.parse(data.toString());
        } catch {
            return;
        }

        try {
            /*
             * REGISTRATION
             */

            if (message.type === "register") {
                const username = String(message.username || "")
                    .trim()
                    .substring(0, 30);

                const password = String(message.password || "");

                if (username.length < 3) {
                    sendError(
                        socket,
                        "Логин должен содержать минимум 3 символа"
                    );
                    return;
                }

                if (password.length < 6) {
                    sendError(
                        socket,
                        "Пароль должен содержать минимум 6 символов"
                    );
                    return;
                }

                const existing = await pool.query(
                    "SELECT id FROM users WHERE LOWER(username) = LOWER($1)",
                    [username]
                );

                if (existing.rows.length > 0) {
                    sendError(
                        socket,
                        "Пользователь с таким логином уже существует"
                    );
                    return;
                }

                const { salt, hash } = createPasswordHash(password);

                const result = await pool.query(
                    `
                    INSERT INTO users
                    (username, password_hash, password_salt)
                    VALUES ($1, $2, $3)
                    RETURNING id, username
                    `,
                    [username, hash, salt]
                );

                const user = result.rows[0];

                users.set(socket, {
                    id: user.id,
                    username: user.username
                });

                socket.send(JSON.stringify({
                    type: "auth_success",
                    user: {
                        id: user.id,
                        username: user.username
                    }
                }));

                console.log(
                    "Зарегистрирован пользователь:",
                    user.username
                );

                await sendUserList();

                return;
            }

            /*
             * LOGIN
             */

            if (message.type === "login") {
                const username = String(message.username || "")
                    .trim()
                    .substring(0, 30);

                const password = String(message.password || "");

                if (!username || !password) {
                    sendError(
                        socket,
                        "Введите логин и пароль"
                    );
                    return;
                }

                const result = await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        password_hash,
                        password_salt
                    FROM users
                    WHERE LOWER(username) = LOWER($1)
                    `,
                    [username]
                );

                if (result.rows.length === 0) {
                    sendError(
                        socket,
                        "Неверный логин или пароль"
                    );
                    return;
                }

                const user = result.rows[0];

                const passwordCorrect = checkPassword(
                    password,
                    user.password_salt,
                    user.password_hash
                );

                if (!passwordCorrect) {
                    sendError(
                        socket,
                        "Неверный логин или пароль"
                    );
                    return;
                }

                users.set(socket, {
                    id: user.id,
                    username: user.username
                });

                socket.send(JSON.stringify({
                    type: "auth_success",
                    user: {
                        id: user.id,
                        username: user.username
                    }
                }));

                console.log(
                    "Вошёл пользователь:",
                    user.username
                );

                await sendUserList();

                return;
            }

            /*
             * MESSAGE
             */

            if (message.type === "private_message") {
                const sender = users.get(socket);

                if (!sender) {
                    sendError(
                        socket,
                        "Сначала войдите в аккаунт"
                    );
                    return;
                }

                const recipientId = Number(message.to);

                const text = String(message.text || "")
                    .trim()
                    .substring(0, 2000);

                if (!recipientId || !text) {
                    return;
                }

                const recipientResult = await pool.query(
                    `
                    SELECT id, username
                    FROM users
                    WHERE id = $1
                    `,
                    [recipientId]
                );

                if (recipientResult.rows.length === 0) {
                    sendError(
                        socket,
                        "Пользователь не найден"
                    );
                    return;
                }

                const recipient = recipientResult.rows[0];

                const saved = await pool.query(
                    `
                    INSERT INTO messages
                    (sender_id, recipient_id, text)
                    VALUES ($1, $2, $3)
                    RETURNING
                        id,
                        sender_id,
                        recipient_id,
                        text,
                        created_at
                    `,
                    [
                        sender.id,
                        recipient.id,
                        text
                    ]
                );

                const savedMessage = saved.rows[0];

                const outgoingMessage = {
                    type: "private_message",
                    id: savedMessage.id,
                    from: sender.id,
                    fromUsername: sender.username,
                    to: recipient.id,
                    toUsername: recipient.username,
                    text: savedMessage.text,
                    time: new Date(
                        savedMessage.created_at
                    ).toLocaleTimeString(
                        "ru-RU",
                        {
                            hour: "2-digit",
                            minute: "2-digit"
                        }
                    )
                };

                /*
                 * Отправляем получателю
                 */

                for (const [client, user] of users.entries()) {
                    if (
                        user.id === recipient.id &&
                        client.readyState === WebSocket.OPEN
                    ) {
                        client.send(
                            JSON.stringify(outgoingMessage)
                        );
                    }
                }

                /*
                 * Отправляем копию отправителю
                 */

                socket.send(
                    JSON.stringify(outgoingMessage)
                );

                return;
            }

            /*
             * CHAT HISTORY
             */

            if (message.type === "get_history") {
                const user = users.get(socket);

                if (!user) {
                    sendError(
                        socket,
                        "Сначала войдите в аккаунт"
                    );
                    return;
                }

                const otherUserId = Number(message.userId);

                if (!otherUserId) {
                    return;
                }

                const result = await pool.query(
                    `
                    SELECT
                        m.id,
                        m.sender_id,
                        m.recipient_id,
                        m.text,
                        m.created_at,
                        s.username AS sender_username,
                        r.username AS recipient_username
                    FROM messages m
                    JOIN users s
                        ON s.id = m.sender_id
                    JOIN users r
                        ON r.id = m.recipient_id
                    WHERE
                        (
                            m.sender_id = $1
                            AND m.recipient_id = $2
                        )
                        OR
                        (
                            m.sender_id = $2
                            AND m.recipient_id = $1
                        )
                    ORDER BY m.created_at ASC
                    LIMIT 500
                    `,
                    [
                        user.id,
                        otherUserId
                    ]
                );

                const history = result.rows.map(message => ({
                    id: message.id,
                    from: message.sender_id,
                    fromUsername: message.sender_username,
                    to: message.recipient_id,
                    toUsername: message.recipient_username,
                    text: message.text,
                    time: new Date(
                        message.created_at
                    ).toLocaleTimeString(
                        "ru-RU",
                        {
                            hour: "2-digit",
                            minute: "2-digit"
                        }
                    )
                }));

                socket.send(JSON.stringify({
                    type: "history",
                    userId: otherUserId,
                    messages: history
                }));

                return;
            }
        } catch (error) {
            console.error("Ошибка:", error);

            sendError(
                socket,
                "Ошибка сервера"
            );
        }
    });

    socket.on("close", async () => {
        const user = users.get(socket);

        users.delete(socket);

        if (user) {
            console.log(
                "Отключился:",
                user.username
            );
        }

        await sendUserList();
    });
});

async function start() {
    try {
        await initDatabase();

        server.listen(
            PORT,
            "0.0.0.0",
            () => {
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
            }
        );
    } catch (error) {
        console.error(
            "Не удалось подключиться к PostgreSQL:"
        );
        console.error(error);
        process.exit(1);
    }
}

start();
