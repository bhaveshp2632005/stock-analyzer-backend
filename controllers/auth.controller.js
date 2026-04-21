import User from "../models/User.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/* ── helpers ── */
const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });

const safeUser = (user) => ({
  id:    user._id,
  name:  user.name,
  email: user.email,
});

/* ══════════════════════════════
   SIGNUP
   POST /api/auth/signup
   Body: { name, email, password }
   Returns: { token, user: { id, name, email } }
══════════════════════════════ */
export const signup = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    /* ── Validation ── */
    if (!name || !email || !password)
      return res.status(400).json({ message: "All fields are required" });

    if (password.length < 6)
      return res.status(400).json({ message: "Password must be at least 6 characters" });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email))
      return res.status(400).json({ message: "Invalid email format" });

    /* ── Duplicate check ── */
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists)
      return res.status(400).json({ message: "Email already registered" });

    /* ── Hash + Create ── */
    const hashed = await bcrypt.hash(password, 12);
    const user   = await User.create({
      name:     name.trim(),
      email:    email.toLowerCase(),
      password: hashed,
    });

    const token = generateToken(user._id);

    /* ── IMPORTANT: token is INSIDE user object too ──
       Frontend reads: user?.token  (from localStorage)
       So we embed token in user object as well          */
    res.status(201).json({
      token,
      user: { ...safeUser(user), token },   // ← token inside user too
    });

  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ message: "Server error during signup" });
  }
};

/* ══════════════════════════════
   LOGIN
   POST /api/auth/login
   Body: { email, password }
   Returns: { token, user: { id, name, email, token } }
══════════════════════════════ */
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    /* ── Validation ── */
    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required" });

    /* ── Find user ── */
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user)
      return res.status(400).json({ message: "Invalid email or password" });

    /* ── Password check ── */
    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(400).json({ message: "Invalid email or password" });

    const token = generateToken(user._id);

    res.json({
      token,
      user: { ...safeUser(user), token },   // ← token inside user too
    });

  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ message: "Server error during login" });
  }
};

/* ══════════════════════════════
   VERIFY TOKEN  (optional — for future use)
   GET /api/auth/me
   Header: Authorization: Bearer <token>
══════════════════════════════ */
export const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user)
      return res.status(404).json({ message: "User not found" });

    res.json({ user: safeUser(user) });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};