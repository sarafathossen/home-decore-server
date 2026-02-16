const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const app = express();

app.use(cors());

const port = process.env.PORT || 3000;

const crypto = require("crypto");

const admin = require("firebase-admin");


const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

function generateTrackingId() {
  // Format date as YYYYMMDD
  const date = new Date().toISOString().split("T")[0].replace(/-/g, "");

  // Generate 4 random bytes → 8 hex chars
  const random = crypto.randomBytes(4).toString("hex").toUpperCase();

  // Final tracking ID
  return `TRK-${date}-${random}`;
}


// Middleware
const verifyFbToken = async (req, res, next) => {
  // console.log('headers in the middle ware', req.headers?.authorization)
  const token = req.headers.authorization
  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' })
  }
  try {
    const idToken = token.split(' ')[1]
    const decoded = await admin.auth().verifyIdToken(idToken)
    console.log('decoded token', decoded)
    req.decoded_email = decoded.email
    next()
  }
  catch (err) {
    return res.status(401).send({ message: 'unauthorized access' })
  }

}

// MONGO DB CONNECTION
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vmnyifr.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {


    const db = client.db('decoration_booking_system');
    const userCollections = db.collection('users');
    // const parcelsCollections = db.collection('parcels');
    const paymentCollections = db.collection('payments');
    // const servicesCollection = db.collection('services');
    const bookingCollection = db.collection('booking');
    // const decoratorCollection = db.collection('decorator');
    const trackingCollection = db.collection('tracking');
    const productsCollection = db.collection('products');
    const landingPageBookingCollection = db.collection('landingPageBooking');



    // middle admin before allowing admin activity
    // must be used after verifyFBToken middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollections.findOne(query);

      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
      }

      next();
    }
    const verifyDecorator = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollections.findOne(query);

      if (!user || user.role !== 'decorator') {
        return res.status(403).send({ message: 'forbidden access' });
      }

      next();
    }

    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split('_').join(' '),
        createdAt: new Date()
      }
      const result = await trackingCollection.insertOne(log);
      return result;
    }


   

    app.use(express.json());

    // Landing Page Product Related API 
    app.get('/products', async (req, res) => {

      const query = {};


      const result = await productsCollection.find().toArray()

      res.send(result)
    })
    app.get('/landing-page-booking', async (req, res) => {

      const query = {};


      const result = await landingPageBookingCollection.find().toArray()

      res.send(result)
    })

    app.post("/landing-page-booking", async (req, res) => {
      const booking = req.body;

      const trackingId = generateTrackingId();

      const result = await bookingCollection.insertOne({
        ...booking,
        trackingId,
        paymentStatus: "pending",
        createdAt: new Date()
      });

      res.send({
        bookingId: result.insertedId,
        trackingId
      });
    });


    

    // payment-success.route.js
    app.get("/payment-success", async (req, res) => {
      const { session_id } = req.query;

      try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        const paymentIntent = await stripe.paymentIntents.retrieve(
          session.payment_intent
        );

        // 🔹 same data for both collections
        const paymentInfo = {
          sessionId: session.id,
          transactionId: paymentIntent.id,
          paymentStatus: session.payment_status,
          amount: paymentIntent.amount / 100,
          currency: paymentIntent.currency,
          customerEmail: session.customer_details?.email,
          paymentMethod: paymentIntent.payment_method_types,
          createdAt: new Date(),
        };

        // 🔹 duplicate check (recommended)
        const exists = await paymentCollections.findOne({
          sessionId: session.id,
        });

        if (!exists) {
          await paymentCollections.insertOne(paymentInfo);
          await landingPageBookingCollection.insertOne(paymentInfo);
        }

        res.send({
          success: true,
          status: session.payment_status,
          transactionId: paymentIntent.id,
          amount: paymentIntent.amount / 100,
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: "Payment verification failed" });
      }
    });


    app.post("/payment-checkout-session", async (req, res) => {
      try {
        const { bookingId, amount, productName, customerEmail, trackingId } = req.body;

        if (!bookingId || !amount || !productName) {
          return res.status(400).send({
            success: false,
            message: "Missing required fields",
          });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          customer_email: customerEmail || undefined,

          line_items: [
            {
              price_data: {
                currency: "bdt",
                product_data: {
                  name: productName,
                },
                unit_amount: amount * 100,
              },
              quantity: 1,
            },
          ],

          metadata: {
            bookingId,
            trackingId,
          },

          success_url: `https://bismilla-landing.netlify.app/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `https://bismilla-landing.netlify.app/payment-cancel`,
        });

        res.send({ url: session.url });

      } catch (error) {
        console.error("Stripe checkout error:", error);
        res.status(500).send({
          success: false,
          message: "Stripe session creation failed",
        });
      }
    });



    // User Related API 
    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = 'user';
      user.createdAt = new Date();
      const email = user.email;
      const existingUser = await userCollections.findOne({ email: email });
      if (existingUser) {
        return res.send({ message: 'User already exists' })
      }
      const result = await userCollections.insertOne(user);
      res.send(result);
    });



    // Payment API
    // app.post("/payment-checkout-session", async (req, res) => {
    //   const { bookingId, productName, amount, customerEmail } = req.body;

    //   const session = await stripe.checkout.sessions.create({
    //     payment_method_types: ["card"],
    //     mode: "payment",
    //     customer_email: customerEmail,

    //     line_items: [
    //       {
    //         price_data: {
    //           currency: "bdt",
    //           product_data: {
    //             name: productName,
    //           },
    //           unit_amount: amount * 100,
    //         },
    //         quantity: 1,
    //       },
    //     ],

    //     metadata: {
    //       bookingId: bookingId,          // 🔑 must
    //       parcelId: bookingId,           // তোমার pattern অনুযায়ী
    //       parcelName: productName,
    //       trackingId: `TRK-${Date.now()}` // auto generate
    //     },

    //     success_url: `https://bismilla-landing.netlify.app/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    //     cancel_url: `https://bismilla-landing.netlify.app/payment-cancel`,
    //   });

    //   res.send({ url: session.url });
    // });
    app.post("/payment-checkout-session", async (req, res) => {
      const { price, productName } = req.body;

      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: productName,
                },
                unit_amount: price * 100,
              },
              quantity: 1,
            },
          ],
          success_url: `https://bismilla-landing.netlify.app/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `https://bismilla-landing.netlify.app/payment-cancel`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: "Stripe session error" });
      }
    });


    app.patch('/payment-success', async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId) {
          return res.status(400).send({
            success: false,
            message: "session_id missing"
          });
        }

        // 1️⃣ Retrieve Stripe session
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== 'paid') {
          return res.send({
            success: false,
            message: "Payment not completed"
          });
        }

        // 2️⃣ Metadata safe access
        const bookingId = session.metadata?.bookingId;
        const trackingId = session.metadata?.trackingId || `TRK-${Date.now()}`;
        const transactionId = session.payment_intent;

        if (!bookingId) {
          return res.status(400).send({
            success: false,
            message: "bookingId missing in Stripe metadata"
          });
        }

        // 3️⃣ Update BOOKING (✅ correct collection)
        const bookingQuery = ObjectId.isValid(bookingId)
          ? { _id: new ObjectId(bookingId) }
          : { _id: bookingId };

        const bookingUpdate = await landingPageBookingCollection.updateOne(
          bookingQuery,
          {
            $set: {
              paymentStatus: 'paid',
              transactionId,
              trackingId,
              paidAt: new Date(),
            },
          }
        );

        // 4️⃣ Prevent duplicate payment save
        const existingPayment = await paymentCollections.findOne({
          stripeSessionId: session.id
        });

        if (!existingPayment) {
          await paymentCollections.insertOne({
            bookingId,
            stripeSessionId: session.id,
            transactionId,
            amount: session.amount_total / 100,
            currency: session.currency,
            customerEmail: session.customer_email,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
          });
        }

        // 5️⃣ Final response
        return res.send({
          success: true,
          transactionId,
          trackingId,
          bookingUpdated: bookingUpdate.modifiedCount === 1
        });

      } catch (error) {
        console.error("Payment success error:", error);
        res.status(500).send({
          success: false,
          message: "Server error"
        });
      }
    });











    app.get('/payments', async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.customerEmail = email;
      }

      const result = await paymentCollections
        .find(query)
        .sort({ paidAt: -1 }) // 🔥 latest payment first
        .toArray();

      res.send(result);
    });





    // app.patch('/payment-success', async (req, res) => {
    //   try {
    //     const sessionId = req.query.session_id;
    //     if (!sessionId) return res.status(400).send({ success: false, message: "Missing session_id" });

    //     const session = await stripe.checkout.sessions.retrieve(sessionId);
    //     const transactionId = session.payment_intent;
    //     console.log(transactionId)

    //     // Duplicate check
    //     const existingPayment = await paymentCollections.findOne({ transactionId });
    //     if (existingPayment) {
    //       return res.send({
    //         success: true,
    //         message: 'Payment already processed',
    //         transactionId,
    //         trackingId: existingPayment.trackingId
    //       });
    //     }

    //     if (session.payment_status !== 'paid') return res.send({ success: false, message: "Payment not completed" });
    //     if (!session.metadata?.parcelId) return res.status(400).send({ success: false, message: "Missing metadata" });

    //     const parcelId = session.metadata.parcelId;
    //     const trackingId = generateTrackingId();

    //     // Safe query
    //     const query = ObjectId.isValid(parcelId)
    //       ? { _id: new ObjectId(parcelId) }
    //       : { _id: parcelId };

    //     const updateResult = await bookingCollection.updateOne(query, {
    //       $set: {
    //         paymentStatus: 'paid',
    //         workingStatus: 'pending-pickup',
    //         trackingId: trackingId
    //       }
    //     });

    //     console.log("UpdateResult:", updateResult);

    //     const paymentData = {
    //       amount: session.amount_total / 100,
    //       currency: session.currency,
    //       customerEmail: session.customer_email,
    //       parcelId,
    //       parcelName: session.metadata.parcelName,
    //       transactionId,
    //       paymentStatus: session.payment_status,
    //       paidAt: new Date(),
    //       trackingId,
    //       workingStatus: 'pending-pickup', // <-- fixed here
    //     };


    //     const paymentInsert = await paymentCollections.insertOne(paymentData);
    //     logTracking(trackingId, 'pending-pickup');
    //     return res.send({
    //       success: true,
    //       message: "Payment processed successfully",
    //       transactionId,
    //       trackingId,
    //       modifyParcel: updateResult,
    //       paymentInfo: paymentInsert
    //     });

    //   } catch (err) {
    //     console.error("Payment Success Handler Error:", err);
    //     return res.status(500).send({ success: false, message: "Server error" });
    //   }
    // });




    // User Related API 
    app.get('/users', async (req, res) => {
      const cursor = userCollections.find();
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollections.findOne(query);
      res.send({ role: user?.role || 'user' });
    })


    // MAke Admin 
    app.patch('/users/:id/role', verifyFbToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          role: roleInfo.role
        }
      }
      const result = await userCollections.updateOne(query, updatedDoc)
      res.send(result);
    })





    // Booking Count API 
    app.get('/booking/working-status/status', verifyFbToken, verifyAdmin, async (req, res) => {
      const pipeline = [
        {
          $facet: {
            // 🔹 Working Status wise count
            workingStatus: [
              {
                $group: {
                  _id: '$workingStatus',
                  count: { $sum: 1 }
                }
              },
              {
                $project: {
                  _id: 0,
                  workingStatus: '$_id',
                  count: 1
                }
              }
            ],

            // 🔹 Category wise count
            category: [
              {
                $group: {
                  _id: '$category',
                  count: { $sum: 1 }
                }
              },
              {
                $project: {
                  _id: 0,
                  category: '$_id',
                  count: 1
                }
              }
            ]
          }
        }
      ];

      const result = await bookingCollection.aggregate(pipeline).toArray();
      res.send(result[0]); // 🔥 খুব গুরুত্বপূর্ণ
    });

    // Tracking Realted API 
    app.get('/trackings/:trackingId/logs', async (req, res) => {
      const trackingId = req.params.trackingId
      const query = { trackingId }
      const result = await trackingCollection.find(query).toArray()
      res.send(result)
    })

    // MongoDB test ping
    // await client.db("admin").command({ ping: 1 });
    // console.log("Connected to MongoDB!");
  } finally { }
}

run().catch(console.dir);


// HOME ROUTE
app.get('/', (req, res) => {
  res.send('Home Decore');
});

// SERVER LISTEN
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
