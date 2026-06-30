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

// 2. Modèles de données (CORRIGÉ : Support des scores, des phases de match et qualifications)
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
    prediction: String, // Contient '1' ou '2' (L'équipe qualifiée en phase finale, ou le prono en 16e)
    score1: { type: Number, default: null }, // Score pronostiqué Équipe 1 au bout des 90 min
    score2: { type: Number, default: null }, // Score pronostiqué Équipe 2 au bout des 90 min
    datePari: Date 
});

const Match = mongoose.model('Match', { 
    teams: String, 
    code1: String, 
    code2: String, 
    date: Date,
    phase: { type: String, default: 'seizieme' }, // 'seizieme', 'huitieme', 'quart', 'demie', 'finale'
    result: { type: String, default: null }, // Contient '1' ou '2' (L'équipe qui s'est qualifiée / a gagné au final)
    score1: { type: Number, default: null }, // Score réel final Équipe 1 au bout des 90 min
    score2: { type: Number, default: null }, // Score réel final Équipe 2 au bout des 90 min
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
                        // 16èmes de finale : Règle classique de base (Victoire simple = 3 points)
                        if (match.result === bet.prediction) {
                            points += 3;
                        }
                    } else {
                        // À partir des 8èmes de finale : Barème évolué cumulable
                        // Règle 1 : Trouve l'équipe qualifiée (prediction stocke '1' ou '2') -> +3 pts
                        if (bet.prediction === match.result) {
                            points += 3;
                        }
                        
                        // Règle 2 : Trouve le score exact au bout des 90 minutes -> +3 pts supplémentaires
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
                    // Pour la série de badges, on valide si le joueur a trouvé l'issue finale (le qualifié / vainqueur)
                    if (bet.prediction === match.result) {
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
        const { matchId, prediction, score1, score2, qualifiedWinner, betId } = req.body; 
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
            
            // Si égalité au bout des 90min, on prend la valeur du bouton radio 'qualifiedWinner' ('1' ou '2')
            if (updateData.score1 === updateData.score2) {
                updateData.prediction = qualifiedWinner; 
            } else {
                // Sinon, le vainqueur se déduit directement des buts
                updateData.prediction = updateData.score1 > updateData.score2 ? '1' : '2';
            }
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

// Gestion de la clôture par score exact et qualification finale
app.post('/admin/match/result', async (req, res) => {
    try {
        const { matchId, result, score1, score2 } = req.body;
        
        let updateFields = { result: result };
        
        // Si l'admin soumet via le formulaire à score (Phases finales)
        if (score1 !== undefined && score2 !== undefined && score1 !== "" && score2 !== "") {
            updateFields.score1 = parseInt(score1);
            updateFields.score2 = parseInt(score2);
            
            if (updateFields.score1 === updateFields.score2) {
                // S'il y a égalité à la fin des 90 minutes (ex: 1-1), l'administration devra 
                // idéalement envoyer l'équipe qualifiée ('1' ou '2') via un traitement ou un ajustement.
                // Par défaut, si non précisé par l'interface admin modifiée, on garde la valeur transmise.
                updateFields.result = result; 
            } else {
                updateFields.result = updateFields.score1 > updateFields.score2 ? '1' : '2';
            }
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