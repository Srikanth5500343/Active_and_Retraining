package com.racktrack.app;

import android.opengl.GLES11Ext;
import android.opengl.GLES20;

import com.google.ar.core.Coordinates2d;
import com.google.ar.core.Frame;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/**
 * Renders the ARCore camera image as the GLSurfaceView backdrop.
 *
 * Adapted from Google's ARCore "hello_ar_java" sample. We bind a single
 * GL_TEXTURE_EXTERNAL_OES texture, hand its name to Session.setCameraTextureName,
 * and draw a fullscreen quad whose UVs are recomputed each frame from
 * Frame.transformCoordinates2d so the camera image is letterboxed/cropped
 * correctly for the current display orientation.
 */
class BackgroundRenderer {

    private static final int COORDS_PER_VERTEX = 2;
    private static final int FLOAT_SIZE = 4;
    private static final int NUM_VERTICES = 4;

    private static final float[] QUAD_COORDS = new float[]{
        -1.0f, -1.0f,
        +1.0f, -1.0f,
        -1.0f, +1.0f,
        +1.0f, +1.0f,
    };

    private static final String VERTEX_SHADER =
        "attribute vec4 a_Position;\n" +
        "attribute vec2 a_TexCoord;\n" +
        "varying vec2 v_TexCoord;\n" +
        "void main() {\n" +
        "  gl_Position = a_Position;\n" +
        "  v_TexCoord = a_TexCoord;\n" +
        "}";

    private static final String FRAGMENT_SHADER =
        "#extension GL_OES_EGL_image_external : require\n" +
        "precision mediump float;\n" +
        "varying vec2 v_TexCoord;\n" +
        "uniform samplerExternalOES sTexture;\n" +
        "void main() {\n" +
        "  gl_FragColor = texture2D(sTexture, v_TexCoord);\n" +
        "}";

    private FloatBuffer quadCoords;
    private FloatBuffer quadTexCoords;
    private int program;
    private int positionAttrib;
    private int texCoordAttrib;
    private int textureId = -1;

    int getTextureId() {
        return textureId;
    }

    void createOnGlThread() {
        int[] textures = new int[1];
        GLES20.glGenTextures(1, textures, 0);
        textureId = textures[0];
        int target = GLES11Ext.GL_TEXTURE_EXTERNAL_OES;
        GLES20.glBindTexture(target, textureId);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);

        ByteBuffer bbCoords = ByteBuffer.allocateDirect(NUM_VERTICES * COORDS_PER_VERTEX * FLOAT_SIZE);
        bbCoords.order(ByteOrder.nativeOrder());
        quadCoords = bbCoords.asFloatBuffer();
        quadCoords.put(QUAD_COORDS);
        quadCoords.position(0);

        ByteBuffer bbTexCoords = ByteBuffer.allocateDirect(NUM_VERTICES * COORDS_PER_VERTEX * FLOAT_SIZE);
        bbTexCoords.order(ByteOrder.nativeOrder());
        quadTexCoords = bbTexCoords.asFloatBuffer();

        int vs = compileShader(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER);
        int fs = compileShader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER);
        program = GLES20.glCreateProgram();
        GLES20.glAttachShader(program, vs);
        GLES20.glAttachShader(program, fs);
        GLES20.glLinkProgram(program);
        GLES20.glUseProgram(program);
        positionAttrib = GLES20.glGetAttribLocation(program, "a_Position");
        texCoordAttrib = GLES20.glGetAttribLocation(program, "a_TexCoord");
    }

    void draw(Frame frame) {
        if (frame.hasDisplayGeometryChanged()) {
            frame.transformCoordinates2d(
                Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES,
                quadCoords,
                Coordinates2d.TEXTURE_NORMALIZED,
                quadTexCoords);
        }
        if (frame.getTimestamp() == 0) {
            return;
        }

        GLES20.glDepthMask(false);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glUseProgram(program);

        quadCoords.position(0);
        GLES20.glVertexAttribPointer(positionAttrib, COORDS_PER_VERTEX, GLES20.GL_FLOAT, false, 0, quadCoords);
        quadTexCoords.position(0);
        GLES20.glVertexAttribPointer(texCoordAttrib, COORDS_PER_VERTEX, GLES20.GL_FLOAT, false, 0, quadTexCoords);

        GLES20.glEnableVertexAttribArray(positionAttrib);
        GLES20.glEnableVertexAttribArray(texCoordAttrib);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, NUM_VERTICES);
        GLES20.glDisableVertexAttribArray(positionAttrib);
        GLES20.glDisableVertexAttribArray(texCoordAttrib);

        GLES20.glDepthMask(true);
    }

    private static int compileShader(int type, String src) {
        int shader = GLES20.glCreateShader(type);
        GLES20.glShaderSource(shader, src);
        GLES20.glCompileShader(shader);
        int[] status = new int[1];
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0);
        if (status[0] == 0) {
            String log = GLES20.glGetShaderInfoLog(shader);
            GLES20.glDeleteShader(shader);
            throw new RuntimeException("Shader compile failed: " + log);
        }
        return shader;
    }
}
