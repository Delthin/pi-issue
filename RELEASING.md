# 发布

## 发布前检查

1. 更新 `package.json`、`package-lock.json` 中的版本号和 `CHANGELOG.md`。
2. 使用 Node.js 22.19.0 或更高版本运行：

   ```sh
   npm ci --include=dev --ignore-scripts
   npm run check
   npm pack --dry-run
   ```

3. 检查包内容：`package.json`、`index.ts`、`README.md`、`CHANGELOG.md` 和 `LICENSE`。
4. 在 Pi 中验证添加、浏览、开始处理和解决 issue，以及删除操作的确认与取消。
5. 确认 GitHub Actions 检查通过。

## 发布到 npm

```sh
npm login
npm whoami
npm publish --access public
```

`prepublishOnly` 会在发布前执行检查。已发布的版本需要递增版本号后才能再次发布。

## 发布后验证

将下方 `<version>` 替换为发布的版本号：

```sh
npm view pi-issue@<version> version dist.integrity
pi install npm:pi-issue@<version>
```

验证安装、命令和数据持久化，然后创建对应的 Git tag 和 GitHub Release。
