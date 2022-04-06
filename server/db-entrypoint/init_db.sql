CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY NOT NULL,
  ip VARCHAR(64) NOT NULL,
  hash_id VARCHAR(64) NOT NULL,
  post VARCHAR(500) NOT NULL,

  notifylist TEXT NULL,

  nsfw BOOLEAN DEFAULT false NOT NULL,
  time INT NOT NULL,
  attachment VARCHAR(600) NOT NULL DEFAULT('n/a'),
  score INT NOT NULL DEFAULT(0),

  voters text NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY NOT NULL,
  ip VARCHAR(64) NOT NULL,
  comment VARCHAR(500) NOT NULL,
  parent INT NOT NULL,
  parentComment INT NULL,
  time INT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY NOT NULL,
  ip VARCHAR(64) NOT NULL,
  commentText VARCHAR(500) NOT NULL,
  postID INT NOT NULL,
  commentID INT NOT NULL
);
