import jwt from "jsonwebtoken";
import User from "../models/User.js";

const extractToken = (req) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.split(" ")[1];
  return token && token.length > 10 ? token : null;
};

export const verifyToken = (req, res, next) => {
  const token = extractToken(req);
  if (!token)
    return res.status(401).json({ message: "Access denied. No token provided." });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res.status(401).json({ message: "Token expired. Please login again." });
    return res.status(401).json({ message: "Invalid token." });
  }
};

export const protect = async (req, res, next) => {
  const token = extractToken(req);
  if (!token)
    return res.status(401).json({ message: "Access denied. No token provided." });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findById(decoded.id).select("-password");
    if (!user)
      return res.status(401).json({ message: "User no longer exists." });
    req.user = user;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res.status(401).json({ message: "Token expired. Please login again." });
    return res.status(401).json({ message: "Invalid token." });
  }
};

export const sanitizeSymbol = (req, res, next) => {
  const symbol = req.params.symbol || req.query.symbol || "";
  if (!/^[A-Z0-9.\-]{1,20}$/i.test(symbol))
    return res.status(400).json({ error: "Invalid stock symbol format." });
  next();
};