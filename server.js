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

// 2. Modèles de données (CORRIGÉ : Support des scores et des phases de match)
const User = mongoose.model('User', { 
    username: { type: String, unique: true, required: true }, 
    firstName: { type: String, required: true },
    lastName: { type: String, required: true }, 
    password: { type: String, required: true },
    badges: { type: [String], default: [] } 
});

const Bet = mongoose.model('Bet', {
    user: String,
    matchId: String,
    teams: String,
    code1: String,
    code2: String,
    prediction: String, // Contient '1', '2' ou 'N'
    score1: { type: Number, default: null }, // Score pronostiqué Équipe 1
    score2: { type: Number, default: null }, // Score pronostiqué Équipe 2
    datePari: Date 
});

const Match = mongoose.model('Match', { 
    teams: String, 
    code1: String, 
    code2: String, 
    date: Date,
    phase: { type: String, default: 'seizieme' }, // 'seizieme', 'huitieme', 'quart', 'demie', 'finale'
    result: { type: String, default: null }, // Contient '1', '2' ou 'N' après traitement
    score1: { type: Number, default: null }, // Score réel final Équipe 1
    score2: { type: Number, default: null }, // Score réel final Équipe 2
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

        // --- CALCUL DU CLASSEMENT & DES SÉRIES DE BADGES ---
        const leaderboard = users.map(u => {
            let points = 0;
            
            // Récupérer les paris de ce joueur spécifique
            const userBets = allBets.filter(b => b.user === u.username);
            
            // 🔄 ÉTAPE A : Calcul des points accumulés dynamique selon la règle de phase
            userBets.forEach(bet => {
                const match = matches.find(m => m._id.toString() === bet.matchId);
                if (match && match.result) {
                    const isKnockout = ['huitieme', 'quart', 'demie', 'finale'].includes(match.phase);

                    if (!isKnockout) {
                        // 16èmes de finale : Règle classique de base (Victoire simple = 3 points d'après ton ancien code)
                        if (match.result === bet.prediction) {
                            points += 3;
                        }
                    } else {
                        // À partir des 8èmes de finale : Barème évolué cumulable
                        const joueurVainqueur = bet.score1 > bet.score2 ? '1' : (bet.score1 < bet.score2 ? '2' : 'N');
                        
                        // Règle 1 : Trouve le vainqueur à la fin du temps réglementaire -> +3 pts
                        let aTrouveVainqueur = (joueurVainqueur === match.result);
                        if (aTrouveVainqueur) {
                            points += 3;
                        }
                        
                        // Règle 2 : Trouve le score exact exact -> +3 pts supplémentaires
                        if (bet.score1 === match.score1 && bet.score2 === match.score2) {
                            points += 3;
                        }
                    }
                }
            });

            // 🔄 ÉTAPE B : Calcul de la plus longue série de bons pronos (Badges)
            const closedMatchesSorted = matches
                .filter(m => m.result !== null)
                .sort((a, b) => new Date(a.date) - new Date(b.date));

            let currentStreak = 0;
            let maxStreak = 0;

            closedMatchesSorted.forEach(match => {
                const bet = userBets.find(b => b.matchId === match._id.toString());
                
                if (bet) {
                    const isKnockout = ['huitieme', 'quart', 'demie', 'finale'].includes(match.phase);
                    let isCorrect = false;

                    if (!isKnockout) {
                        isCorrect = (bet.prediction === match.result);
                    } else {
                        const joueurVainqueur = bet.score1 > bet.score2 ? '1' : (bet.score1 < bet.score2 ? '2' : 'N');
                        // On considère que le prono fait partie de la série si au moins le vainqueur est bon
                        isCorrect = (joueurVainqueur === match.result);
                    }

                    if (isCorrect) {
                        currentStreak++; 
                        if (currentStreak > maxStreak) {
                            maxStreak = currentStreak;
                        }
                    } else {
                        currentStreak = 0; 
                    }
                }
            });

            let calculatedBadges = [];
            if (maxStreak >= 3)  calculatedBadges.push('streak-3');
            if (maxStreak >= 5)  calculatedBadges.push('streak-5');
            if (maxStreak >= 10) calculatedBadges.push('streak-10');

            return {
                name: `${u.firstName} ${u.lastName}`,
                points: points,
                email: u.username,
                badges: calculatedBadges
            };
        });

        leaderboard.sort((a, b) => b.points - a.points);
        const bettedMatchIds = myBets.map(b => b.matchId.toString());

        res.render('index', { 
            user: req.session.user, 
            matches: matches, 
            bets: myBets,
            bettedMatchIds: bettedMatchIds, 
            leaderboard: leaderboard
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur de chargement");
    }
});

app.get('/faq', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.render('faq', { user: req.session.user });
});

app.post('/bet', async (req, res) => {
    try {
        const { matchId, prediction, score1, score2, betId } = req.body; 
        const username = req.session.user.username;

        const matchData = await Match.findById(matchId);
        if (!matchData) return res.status(404).send("Match non trouvé.");

        const maintenantUTC = new Date();
        const maintenantParis = new Date(maintenantUTC.getTime() + (2 * 60 * 60 * 1000));
        const heureMatch = new Date(matchData.date);
        
        if (maintenantParis.getTime() >= heureMatch.getTime()) {
            return res.status(403).send("Trop tard, le match a commencé !");
        }

        const isKnockout = ['huitieme', 'quart', 'demie', 'finale'].includes(matchData.phase);

        let updateData = {
            teams: matchData.teams,
            code1: matchData.code1,
            code2: matchData.code2,
            datePari: new Date()
        };

        if (isKnockout) {
            updateData.score1 = parseInt(score1);
            updateData.score2 = parseInt(score2);
            updateData.prediction = updateData.score1 > updateData.score2 ? '1' : (updateData.score1 < updateData.score2 ? '2' : 'N');
        } else {
            updateData.prediction = prediction;
            updateData.score1 = null;
            updateData.score2 = null;
        }

        if (betId) {
            await Bet.findByIdAndUpdate(betId, updateData);
        } else {
            await Bet.findOneAndUpdate(
                { user: username, matchId: matchId }, 
                updateData, 
                { upsert: true, new: true }
            );
        }

        res.redirect('/');
        
    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur lors de l'enregistrement du pari.");
    }
});

app.get('/login', (req, res) => {
    const status = req.query.status;
    res.render('login', { 
        accountCreated: status === 'registered',
        emailExists: status === 'error_email_exists',
        nameExists: status === 'error_name_exists' 
    });
});

app.post('/register', async (req, res) => {
    try {
        const { email, firstName, lastName, password } = req.body;
        const emailLower = email.toLowerCase();
        
        const fNameClean = firstName.trim();
        const lNameClean = lastName.trim();

        const existingEmail = await User.findOne({ username: emailLower });
        if (existingEmail) {
            return res.redirect('/login?status=error_email_exists');
        }

        const existingName = await User.findOne({
            firstName: { $regex: new RegExp(`^${fNameClean}$`, 'i') },
            lastName: { $regex: new RegExp(`^${lNameClean}$`, 'i') }
        });
        
        if (existingName) {
            return res.redirect('/login?status=error_name_exists');
        }

        const newUser = new User({ 
            username: emailLower, 
            firstName: fNameClean, 
            lastName: lNameClean, 
            password,
            badges: []
        });
        await newUser.save();
        
        res.redirect('/login?status=registered');
    } catch (err) { 
        res.status(500).send("Erreur inscription : " + err.message); 
    }
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

// Ajout du paramètre "phase" à la création du match
app.post('/admin/match', async (req, res) => {
    const { team1, code1, team2, code2, date, phase } = req.body;
    const newMatch = new Match({ 
        teams: `${team1} - ${team2}`,
        code1: code1.toLowerCase(),
        code2: code2.toLowerCase(),
        date: date,
        phase: phase || 'seizieme'
    });
    await newMatch.save();
    res.redirect('back');
});

// Mis à jour pour gérer la clôture par score exact pour les phases finales
app.post('/admin/match/result', async (req, res) => {
    try {
        const { matchId, result, score1, score2 } = req.body;
        
        let updateFields = { result: result };
        if (score1 !== undefined && score2 !== undefined && score1 !== "" && score2 !== "") {
            updateFields.score1 = parseInt(score1);
            updateFields.score2 = parseInt(score2);
            // Calcule automatiquement le résultat '1', '2' ou 'N' pour le fallback
            updateFields.result = updateFields.score1 > updateFields.score2 ? '1' : (updateFields.score1 < updateFields.score2 ? '2' : 'N');
        }

        await Match.findByIdAndUpdate(matchId, updateFields);
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