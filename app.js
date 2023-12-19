const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const multer = require('@koa/multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool(config);
const app = new Koa();

app.use(bodyParser());
app.use(cors());
app.use(koaPg({ connectionString: config.databaseUrl }));

const authenticateToken = async (ctx, next) => {
    const token = ctx.headers.authorization;
    if (!token) {
        ctx.status = 401;
        ctx.body = 'Access Denied';
        return;
    }

    try {
        const user = await jwt.verify(token, config.secret);
        ctx.state.user = user;
        await next();
    } catch (err) {
        ctx.status = 403;
        ctx.body = 'Invalid Token';
    }
};

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(upload.array('images', 5));

app.use(async (ctx, next) => {
    try {
        await next();
    } catch (error) {
        console.error(error);
        ctx.status = 500;
        ctx.body = 'Internal Server Error';
    }
});

app.post('/register', async (ctx) => {
    const { username, password, role } = ctx.request.body;

    const hashedPassword = await bcrypt.hash(password, 10);

    try {
        const result = await pool.query(
            'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING *',
            [username, hashedPassword, role]
        );

        const user = result.rows[0];
        const token = jwt.sign({ id: user.id, role: user.role }, config.secret);
        ctx.status = 201;
        ctx.body = { token };
    } catch (error) {
        console.error(error);
        ctx.status = 500;
        ctx.body = 'Internal Server Error';
    }
});

app.post('/login', async (ctx) => {
    const { username, password } = ctx.request.body;

    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

        const user = result.rows[0];

        if (!user) {
            ctx.status = 401;
            ctx.body = 'Invalid username or password';
            return;
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            ctx.status = 401;
            ctx.body = 'Invalid username or password';
            return;
        }

        const token = jwt.sign({ id: user.id, role: user.role }, config.secret);
        ctx.body = { token };
    } catch (error) {
        console.error(error);
        ctx.status = 500;
        ctx.body = 'Internal Server Error';
    }
});

app.post('/add-product', authenticateToken, async (ctx) => {
    try {
        if (ctx.state.user.role !== 'admin') {
            ctx.status = 403;
            ctx.body = 'У вас нет прав для выполнения этого действия';
            return;
        }

        const { name, description, price } = ctx.request.body;
        const images = ctx.req.files.map(file => file.buffer.toString('base64'));

        const result = await pool.query(
            'INSERT INTO products (name, description, images, price) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, description, images, price]
        );

        const product = result.rows[0];
        ctx.status = 201;
        ctx.body = product;
    } catch (error) {
        console.error(error);
        ctx.status = 500;
        ctx.body = 'Internal Server Error';
    }
});

app.get('/products', async (ctx) => {
    try {
        const result = await pool.query('SELECT * FROM products');
        const products = result.rows;
        ctx.body = products;
    } catch (error) {
        console.error(error);
        ctx.status = 500;
        ctx.body = 'Internal Server Error';
    }
});

app.post('/add-to-cart', authenticateToken, async (ctx) => {
    try {
        const { productId, quantity } = ctx.request.body;
        const userId = ctx.state.user.id;

        const existingCart = await pool.query('SELECT * FROM shopping_carts WHERE user_id = $1', [
            userId,
        ]);

        if (existingCart.rows.length === 0) {
            const newCartResult = await pool.query(
                'INSERT INTO shopping_carts (user_id, products) VALUES ($1, $2) RETURNING *',
                [userId, [{ productId, quantity }]]
            );

            const newCart = newCartResult.rows[0];
            ctx.status = 200;
            ctx.body = newCart;
        } else {
            const existingProducts = existingCart.rows[0].products;
            const updatedProducts = [...existingProducts, { productId, quantity }];

            const updatedCartResult = await pool.query(
                'UPDATE shopping_carts SET products = $1 WHERE user_id = $2 RETURNING *',
                [updatedProducts, userId]
            );

            const updatedCart = updatedCartResult.rows[0];
            ctx.status = 200;
            ctx.body = updatedCart;
        }
    } catch (error) {
        console.error(error);
        ctx.status = 500;
        ctx.body = 'Internal Server Error';
    }
});

app.get('/get-cart', authenticateToken, async (ctx) => {
    try {
        const userId = ctx.state.user.id;

        const result = await pool.query('SELECT * FROM shopping_carts WHERE user_id = $1', [userId]);
        const cart = result.rows[0];

        if (cart) {
            ctx.status = 200;
            ctx.body = cart;
        } else {
            ctx.status = 404;
            ctx.body = 'Корзина не найдена';
        }
    } catch (error) {
        console.error(error);
        ctx.status = 500;
        ctx.body = 'Internal Server Error';
    }
});

app.get('/calculate-total', authenticateToken, async (ctx) => {
    try {
        const userId = ctx.state.user.id;

        const result = await pool.query('SELECT * FROM shopping_carts WHERE user_id = $1', [userId]);
        const cart = result.rows[0];

        if (!cart) {
            ctx.status = 404;
            ctx.body = 'Корзина не найдена';
            return;
        }

        const products = cart.products || [];

        const total = await products.reduce(async (accPromise, product) => {
            const acc = await accPromise;
            const productInfo = await pool.query('SELECT price FROM your_database_table_name WHERE id = $1', [
                product.productId,
            ]);
            const productPrice = productInfo.rows[0].price;
            return acc + productPrice * product.quantity;
        }, Promise.resolve(0));

        ctx.status = 200;
        ctx.body = { total };
    } catch (error) {
        console.error(error);
        ctx.status = 500;
        ctx.body = 'Internal Server Error';
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
