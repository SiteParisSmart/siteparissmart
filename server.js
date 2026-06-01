const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');

const app = express();

// 1. Connexion MongoDB
const MONGO_URI = "mongodb+srv://sebgalle:0603734703aA!@cluster0.jq6f9sg.mongodb.net/paris?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Connecté à MongoDB !"))
  .catch(err => console.error("❌ Erreur de connexion :", err));

// 2. Modèles de données
const User = mongoose.model('User', { 
    username: { type: String, unique: true, required: true }, 
    firstName: { type: String, required: true },
    lastName: { type: String, required: true }, 
    password: { type: String, required: true } 
});

const Bet = mongoose.model('Bet', {
    user: String,
    matchId: String,
    teams: String,
    code1: String,
    code2: String,
    prediction: String,
    datePari: Date // Ajouté pour le suivi
});

const Match = mongoose.model('Match', { 
    teams: String, 
    code1: String, 
    code2: String, 
    date: Date,
    result: { type: String, default: null }, 
    status: { type: String, default: 'open' } 
});

// 3. Configuration
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'secret-key-pour-les-paris',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO_URI }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// --- ROUTES UTILISATEURS ---

app.get('/', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    try {
        const matches = await Match.find();
        const allBets = await Bet.find();
        const users = await User.find();
        const myBets = allBets.filter(b => b.user === req.session.user.username);

        // --- CALCUL DU CLASSEMENT ---
        const leaderboard = users.map(u => {
            let points = 0;
            const userBets = allBets.filter(b => b.user === u.username);
            
            userBets.forEach(bet => {
                const match = matches.find(m => m._id.toString() === bet.matchId);
                if (match && match.result && match.result === bet.prediction) {
                    points += 3;
                }
            });

            return {
                name: `${u.firstName} ${u.lastName}`,
                points: points,
                email: u.username
            };
        });

        leaderboard.sort((a, b) => b.points - a.points);

        // CORRECTION : On s'assure d'envoyer les IDs sous forme de chaînes de caractères
        const bettedMatchIds = myBets.map(b => b.matchId.toString());

        res.render('index', { 
            user: req.session.user, 
            matches: matches, 
            bets: myBets,
            bettedMatchIds: bettedMatchIds, // Utilisé pour griser les options dans index.ejs
            leaderboard: leaderboard
        });
    } catch (err) {
        res.status(500).send("Erreur de chargement");
    }
});

app.get('/faq', (req, res) => {
    // On vérifie si l'utilisateur est connecté (sécurité)
    if (!req.session.user) {
        return res.redirect('/login');
    }
    // On affiche le fichier faq.ejs en lui passant l'utilisateur pour la navbar
    res.render('faq', { user: req.session.user });
});

app.post('/bet', async (req, res) => {
    try {
        const { matchId, prediction, betId } = req.body; // Récupération possible d'un betId si modification
        const username = req.session.user.username;

        const matchData = await Match.findById(matchId);
        if (!matchData) return res.status(404).send("Match non trouvé.");

        // SÉCURITÉ HEURE : Barrière de sécurité côté serveur
        const maintenantUTC = new Date();
        const maintenantParis = new Date(maintenantUTC.getTime() + (2 * 60 * 60 * 1000));
        const heureMatch = new Date(matchData.date);
        
        console.log("--- VERIFICATION FUSEAU ---");
        console.log("Heure actuelle (Paris corrigée) :", maintenantParis.toLocaleString('fr-FR'));
        console.log("Heure de début du match :", heureMatch.toLocaleString('fr-FR'));
        
        // CORRECTION ICI : On utilise bien maintenantParis au lieu de maintenant
        if (maintenantParis.getTime() >= heureMatch.getTime()) {
            return res.status(403).send("Trop tard, le match a commencé !");
        }

        // ANTI-DOUBLON : Utilisation de findOneAndUpdate avec upsert
        // Si un pari existe pour cet utilisateur sur ce match, il est mis à jour.
        // Sinon, il est créé.
        await Bet.findOneAndUpdate(
            { user: username, matchId: matchId }, 
            { 
                prediction: prediction,
                teams: matchData.teams,
                code1: matchData.code1,
                code2: matchData.code2,
                datePari: new Date()
            }, 
            { upsert: true, new: true }
        );

        res.redirect('/');
        
    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur lors de l'enregistrement du pari.");
    }
});

// ... (le reste de tes routes login/register/admin/logout reste inchangé)

app.get('/login', (req, res) => res.render('login'));

app.post('/register', async (req, res) => {
    try {
        const { email, firstName, lastName, password } = req.body;
        const newUser = new User({ 
            username: email.toLowerCase(), 
            firstName, lastName, password 
        });
        await newUser.save();
        res.redirect('/');
    } catch (err) { res.status(500).send("Erreur inscription : " + err.message); }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username.toLowerCase(), password: password });
    if (user) {
        req.session.user = user;
        res.redirect('/');
    } else {
        res.send("Identifiants incorrects. <a href='/'>Réessayer</a>");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// --- ROUTES ADMIN ---

app.get('/admin/:password', async (req, res) => {
    const secret = process.env.ADMIN_PASSWORD || "admin123";
    if (req.params.password !== secret) return res.status(403).send("Accès refusé.");

    try {
        const allBets = await Bet.find().lean();
        const allMatches = await Match.find();
        const allUsers = await User.find();

        const betsWithNames = allBets.map(bet => {
            const userData = allUsers.find(u => u.username === bet.user);
            return {
                ...bet,
                displayName: userData ? `${userData.firstName} ${userData.lastName}` : bet.user
            };
        });

        res.render('admin', { 
            bets: betsWithNames, 
            matches: allMatches, 
            adminPass: req.params.password 
        });
    } catch (err) { 
        console.error(err);
        res.status(500).send("Erreur serveur"); 
    }
});

app.post('/admin/match', async (req, res) => {
    const { team1, code1, team2, code2, date } = req.body;
    const newMatch = new Match({ 
        teams: `${team1} - ${team2}`,
        code1: code1.toLowerCase(),
        code2: code2.toLowerCase(),
        date: date
    });
    await newMatch.save();
    res.redirect('back');
});

app.post('/admin/match/result', async (req, res) => {
    try {
        const { matchId, result } = req.body;
        await Match.findByIdAndUpdate(matchId, { result: result });
        res.redirect('back');
    } catch (err) { res.status(500).send("Erreur résultat"); }
});

app.post('/admin/match/delete', async (req, res) => {
    await Match.findByIdAndDelete(req.body.matchId);
    res.redirect('back');
});

app.post('/admin/delete/:id', async (req, res) => {
    await Bet.findByIdAndDelete(req.params.id);
    res.redirect('back');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Serveur sur le port ${PORT}`));