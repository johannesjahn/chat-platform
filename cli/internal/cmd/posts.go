package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/johannesjahn/chat-platform/cli/internal/api"
)

func feedCmd(a *app) *cobra.Command {
	var limit int
	var cursor, by string
	cmd := &cobra.Command{
		Use:     "feed",
		Aliases: []string{"posts"},
		Short:   "Show the newest posts",
		Example: `  chatctl feed
  chatctl feed --by @alice --limit 5`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			var page *api.PostsPage
			if by != "" {
				u, err := a.resolveUser(ctx, c, by)
				if err != nil {
					return err
				}
				page, err = c.ListUserPosts(ctx, u.ID, cursor, limit)
				if err != nil {
					return err
				}
			} else if page, err = c.ListPosts(ctx, cursor, limit); err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(page)
			}
			if len(page.Posts) == 0 {
				fmt.Fprintln(a.out, "No posts.")
				return nil
			}
			for i := range page.Posts {
				if i > 0 {
					fmt.Fprintln(a.out)
				}
				a.printPost(ctx, &page.Posts[i])
			}
			nextPageHint(a, page.NextCursor, "--cursor")
			return nil
		},
	}
	cmd.Flags().IntVarP(&limit, "limit", "n", 10, "number of posts")
	cmd.Flags().StringVar(&cursor, "cursor", "", "page cursor from a previous call")
	cmd.Flags().StringVar(&by, "by", "", "only posts by this user (@name or id)")
	return cmd
}

func postCmd(a *app) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "post",
		Short: "Create, show, edit, delete, react to, and comment on posts",
	}

	var imageURL, attach string
	create := &cobra.Command{
		Use:   "create [TEXT | -]",
		Short: "Create a post (text from args, stdin, or $EDITOR)",
		Example: `  chatctl post create "Hello from the terminal 👋"
  git log -1 --format=%B | chatctl post create
  chatctl post create              # opens $EDITOR
  chatctl post create --image https://example.com/cat.png
  chatctl post create --attach ./diagram.png`,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, err := a.Client()
			if err != nil {
				return err
			}
			text, err := a.readText(args, imageURL != "" || attach != "")
			if err != nil {
				return err
			}
			content, err := a.content(ctx, c, text, imageURL, attach)
			if err != nil {
				return err
			}
			p, err := c.CreatePost(ctx, content)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(p)
			}
			fmt.Fprintf(a.out, "Posted #%d.\n", p.ID)
			return nil
		},
	}
	create.Flags().StringVar(&imageURL, "image", "", "post an image by URL instead of text")
	create.Flags().StringVar(&attach, "attach", "", "upload a local file and post it (TEXT becomes its caption)")

	var commentLimit int
	show := &cobra.Command{
		Use:   "show POST_ID",
		Short: "Show a post with its comments",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			postID, err := parseID(args[0], "post")
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			p, err := c.GetPost(ctx, postID)
			if err != nil {
				return err
			}
			comments, err := c.ListComments(ctx, postID, "", commentLimit)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(map[string]any{"post": p, "comments": comments})
			}
			a.printPost(ctx, p)
			if len(comments.Comments) > 0 {
				fmt.Fprintln(a.out)
			}
			for i := range comments.Comments {
				a.printComment(ctx, &comments.Comments[i], "  │ ")
			}
			if comments.NextCursor != nil {
				fmt.Fprintln(a.errOut, styleDim("more comments — raise --comments to see them"))
			}
			return nil
		},
	}
	show.Flags().IntVarP(&commentLimit, "comments", "n", 20, "number of comments to show")

	edit := &cobra.Command{
		Use:   "edit POST_ID [TEXT | -]",
		Short: "Replace a text post's content ($EDITOR, pre-filled, if no text given)",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			postID, err := parseID(args[0], "post")
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			text, err := a.readText(args[1:], true)
			if err != nil {
				return err
			}
			if text == "" {
				p, err := c.GetPost(ctx, postID)
				if err != nil {
					return err
				}
				if text, err = editText(p.Content); err != nil {
					return err
				}
				if text == p.Content {
					fmt.Fprintln(a.out, "No changes.")
					return nil
				}
			}
			p, err := c.UpdatePost(ctx, postID, api.Content{Type: api.ContentText, Text: text})
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(p)
			}
			fmt.Fprintf(a.out, "Updated #%d.\n", p.ID)
			return nil
		},
	}

	del := &cobra.Command{
		Use:   "delete POST_ID",
		Short: "Delete a post",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			postID, err := parseID(args[0], "post")
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			if err := c.DeletePost(cmd.Context(), postID); err != nil {
				return err
			}
			fmt.Fprintf(a.out, "Deleted #%d.\n", postID)
			return nil
		},
	}

	comment := &cobra.Command{
		Use:   "comment POST_ID [TEXT | -]",
		Short: "Comment on a post",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			postID, err := parseID(args[0], "post")
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			text, err := a.readText(args[1:], false)
			if err != nil {
				return err
			}
			cm, err := c.CreateComment(cmd.Context(), postID, text)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(cm)
			}
			fmt.Fprintf(a.out, "Commented #%d on post #%d.\n", cm.ID, postID)
			return nil
		},
	}

	cmd.AddCommand(create, show, edit, del, comment, reactCmd(a, "posts", "post"))
	return cmd
}

func commentCmd(a *app) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "comment",
		Short: "Reply to, edit, delete, and react to comments",
	}

	reply := &cobra.Command{
		Use:   "reply COMMENT_ID [TEXT | -]",
		Short: "Reply to a comment",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			commentID, err := parseID(args[0], "comment")
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			text, err := a.readText(args[1:], false)
			if err != nil {
				return err
			}
			cm, err := c.CreateReply(cmd.Context(), commentID, text)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(cm)
			}
			fmt.Fprintf(a.out, "Replied #%d.\n", cm.ID)
			return nil
		},
	}

	replies := &cobra.Command{
		Use:   "replies COMMENT_ID",
		Short: "Show replies to a comment",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			commentID, err := parseID(args[0], "comment")
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			page, err := c.ListReplies(ctx, commentID, "", 50)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(page)
			}
			if len(page.Comments) == 0 {
				fmt.Fprintln(a.out, "No replies.")
			}
			for i := range page.Comments {
				a.printComment(ctx, &page.Comments[i], "")
			}
			return nil
		},
	}

	edit := &cobra.Command{
		Use:   "edit COMMENT_ID [TEXT | -]",
		Short: "Edit a comment",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			commentID, err := parseID(args[0], "comment")
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			text, err := a.readText(args[1:], false)
			if err != nil {
				return err
			}
			cm, err := c.UpdateComment(cmd.Context(), commentID, text)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(cm)
			}
			fmt.Fprintf(a.out, "Updated comment #%d.\n", cm.ID)
			return nil
		},
	}

	del := &cobra.Command{
		Use:   "delete COMMENT_ID",
		Short: "Delete a comment",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			commentID, err := parseID(args[0], "comment")
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			if err := c.DeleteComment(cmd.Context(), commentID); err != nil {
				return err
			}
			fmt.Fprintf(a.out, "Deleted comment #%d.\n", commentID)
			return nil
		},
	}

	cmd.AddCommand(reply, replies, edit, del, reactCmd(a, "comments", "comment"))
	return cmd
}

// reactCmd is `post react` / `comment react`.
func reactCmd(a *app, kind, noun string) *cobra.Command {
	var remove bool
	cmd := &cobra.Command{
		Use:   "react " + noun + "_ID EMOJI",
		Short: "React to a " + noun + " (👍 ❤️ 😂 😮 😢 😡, or like/love/haha/wow/sad/angry)",
		Example: "  chatctl " + noun + " react 42 like\n" +
			"  chatctl " + noun + " react 42 ❤️ --remove",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			targetID, err := parseID(args[0], noun)
			if err != nil {
				return err
			}
			emoji, err := parseReaction(args[1])
			if err != nil {
				return err
			}
			c, err := a.Client()
			if err != nil {
				return err
			}
			state, err := c.React(cmd.Context(), kind, targetID, emoji, remove)
			if err != nil {
				return err
			}
			if a.jsonOut {
				return a.emitJSON(state)
			}
			line := reactionsLine(state.Reactions)
			if line == "" {
				line = styleDim("no reactions")
			}
			fmt.Fprintln(a.out, line)
			return nil
		},
	}
	cmd.Flags().BoolVar(&remove, "remove", false, "remove the reaction instead of adding it")
	return cmd
}
