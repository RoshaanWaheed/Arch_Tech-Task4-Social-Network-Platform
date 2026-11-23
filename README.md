# Arch Circle: Social Network Platform

## Features
- Accounts: register, sign in (JWT), profile photo, name and bio
- Posts with text plus photo, video or audio uploads (up to 25 MB)
- Likes and comments
- Friend requests: send, accept, decline, cancel, unfriend
- Real-time updates over WebSockets (Socket.IO): new posts, likes, comments, notifications, friend requests, online status
- Notifications with an unread badge and live toasts
- Privacy settings: profile and posts visible to everyone or friends only, per-post visibility, option to turn friend requests off

## Run it
1. Install Node.js and have MongoDB running locally, or use a MongoDB Atlas connection string.
2. `npm install`
3. create `.env` file, set `MONGO_URI` and `JWT_SECRET`.
4. `npm start`
5. Create two accounts in two browser windows (one normal, one private) and add each other as friends to see the live updates.

## Structure
- `server.js`: Express REST API, Mongoose models, Socket.IO
- `public/`: front end (HTML, CSS, vanilla JavaScript)
- `uploads/`: created automatically for shared media
